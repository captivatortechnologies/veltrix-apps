import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractAppSpec, validateAppSpec, resolveAppId } from '../../lib/splunkPackage'

/**
 * Validate Splunk app / add-on configurations.
 *
 * Apps are managed through /services/apps/local (+ /services/apps/appinstall
 * for install/upgrade and the ACL endpoint for sharing). The canvas declares
 * the app id, where its package comes from, the version to pin, and its
 * placement/lifecycle (visibility, state, upgrade policy).
 *
 * Rules:
 *   - App ids appear in filesystem paths and REST URLs; restricted to letters,
 *     digits, underscores and hyphens (platform guardrail).
 *   - `source`, `visibility`, `state` and `upgradePolicy` must be one of their
 *     allowed values.
 *   - A `sourceRef` is required for every source; for Splunkbase it must be the
 *     numeric app id, for a URL it must be an https package link.
 */

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const MAX_APP_ID_LENGTH = 128
const SOURCES = new Set(['splunkbase', 'url', 'local', 'inline'])
const VISIBILITIES = new Set(['app', 'global'])
const STATES = new Set(['enabled', 'disabled'])
const UPGRADE_POLICIES = new Set(['manual', 'auto'])
const SPLUNKBASE_ID_PATTERN = /^\d+$/

/** Standard top-level folders in a Splunk app/TA package. */
const APP_FOLDERS = new Set(['default', 'local', 'bin', 'static', 'metadata', 'lookups', 'lib', 'README'])
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

interface FileEntry {
  path?: string
  content?: string
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no app definitions', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const appIds = new Set<string>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = section.name

    // --- App id -------------------------------------------------------------
    // Unnamed items ship under the configuration's own name.
    const name = resolveAppId(fields, ctx.canvas.name) || undefined
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      errors.push({ field: `${prefix}.name`, message: 'App ID is required', code: 'required' })
    } else {
      if (!APP_ID_PATTERN.test(name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'App ID may contain only letters, digits, underscores, and hyphens, and must start with a letter or digit',
          code: 'invalid_format',
        })
      }
      if (name.length > MAX_APP_ID_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `App ID must be ${MAX_APP_ID_LENGTH} characters or fewer`, code: 'max_length' })
      }
      if (appIds.has(name)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate app ID: "${name}"`, code: 'duplicate' })
      }
      appIds.add(name)
    }

    // --- Source + reference -------------------------------------------------
    const source = fields.source as string | undefined
    if (source !== undefined && !SOURCES.has(source)) {
      errors.push({ field: `${prefix}.source`, message: `Invalid install source "${source}"`, code: 'invalid_value' })
    }
    const appFiles = Array.isArray(fields.appFiles) ? (fields.appFiles as FileEntry[]) : []
    const isInline = source === 'inline'
    const sourceRef = fields.sourceRef as string | undefined
    if (isInline) {
      // Inline apps are built from the authored files; no package reference needed.
      if (appFiles.length === 0) {
        errors.push({ field: `${prefix}.appFiles`, message: 'Authoring inline requires at least one file', code: 'required' })
      }
    } else if (!sourceRef || typeof sourceRef !== 'string' || sourceRef.trim().length === 0) {
      errors.push({ field: `${prefix}.sourceRef`, message: 'A source reference is required (Splunkbase id, package URL, or local path)', code: 'required' })
    } else if (source === 'splunkbase' && !SPLUNKBASE_ID_PATTERN.test(sourceRef.trim())) {
      errors.push({ field: `${prefix}.sourceRef`, message: 'Splunkbase source reference must be the numeric app id', code: 'invalid_format' })
    } else if (source === 'url' && !/^https:\/\//i.test(sourceRef.trim())) {
      errors.push({ field: `${prefix}.sourceRef`, message: 'Package URL must be an https link to the .tgz/.spl package', code: 'invalid_format' })
    } else if (source === 'local' && !sourceRef.trim().startsWith('/')) {
      // A "local" source is a package file ALREADY on the target; splunkd installs
      // it by path (name=<path>&filename=1). A bare name is not a path, so splunkd
      // fails to extract it ("No such file or directory"). Catch it here.
      errors.push({
        field: `${prefix}.sourceRef`,
        message: 'Local source must be an ABSOLUTE file path to a package already on the target server (e.g. /opt/splunk/var/run/pkg.spl). A bare name is not a path — to ship .conf files you author here, set Source to "Author files inline" instead.',
        code: 'invalid_format',
      })
    }

    // Authored App Contents ship ONLY for an inline build. With any package source
    // (splunkbase / url / local) they are silently ignored — a common footgun that
    // then surfaces as a cryptic splunkd 500 ("failed to extract app … No such file
    // or directory") when the deploy asks Splunk to install a nonexistent package.
    // Flag it at author time so the fix (usually: switch Source to inline) is obvious.
    if (!isInline && appFiles.length > 0) {
      warnings.push({
        field: `${prefix}.source`,
        message: `Source is "${source ?? 'splunkbase'}" but ${appFiles.length} authored App Content file(s) are declared. Authored files ship ONLY when Source is "Author files inline (build the app/TA)" — with this source they are ignored on deploy. Did you mean to select "Author files inline"?`,
        code: 'authored_files_ignored',
      })
    }

    // --- Authored files (app/TA folder structure) --------------------------
    if (appFiles.length > 0) {
      const seenPaths = new Set<string>()
      let hasConf = false
      appFiles.forEach((file, i) => {
        const path = typeof file?.path === 'string' ? file.path.trim() : ''
        const fieldRef = `${prefix}.appFiles[${i}]`
        if (!path) {
          errors.push({ field: fieldRef, message: 'File path is required', code: 'required' })
          return
        }
        if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
          errors.push({ field: fieldRef, message: `Unsafe file path "${path}"`, code: 'invalid_path' })
          return
        }
        const folder = path.slice(0, path.indexOf('/'))
        const filename = path.slice(path.indexOf('/') + 1)
        if (!path.includes('/') || !APP_FOLDERS.has(folder)) {
          errors.push({
            field: fieldRef,
            message: `File "${path}" must live under a standard app folder (${[...APP_FOLDERS].join(', ')})`,
            code: 'invalid_path',
          })
          return
        }
        if (!filename || !FILENAME_PATTERN.test(path)) {
          errors.push({ field: fieldRef, message: `Invalid filename in "${path}"`, code: 'invalid_format' })
          return
        }
        if (seenPaths.has(path)) {
          errors.push({ field: fieldRef, message: `Duplicate file path "${path}"`, code: 'duplicate' })
        }
        seenPaths.add(path)
        if ((folder === 'default' || folder === 'local') && filename.endsWith('.conf')) hasConf = true
      })
      if (isInline && !hasConf) {
        warnings.push({
          field: `${prefix}.appFiles`,
          message: 'No default/local *.conf files declared — only .conf files are applied over the REST configs API on deploy',
          code: 'no_conf_files',
        })
      }
    }

    // Everything checkable without touching Splunk: the app id and version rules,
    // the [ui] label bounds, Splunk's denied conf files and input stanzas, conf
    // parse errors, absolute paths — and the package is BUILT here, so a path that
    // will not fit a tar header or an oversized archive fails now rather than
    // half-way through a deploy.
    if (isInline) {
      const { spec, issues } = extractAppSpec(fields, {
        build: ctx.canvas.version,
        configName: ctx.canvas.name,
        prefix: `${prefix}.appFiles`,
      })
      errors.push(...issues.errors)
      warnings.push(...issues.warnings)

      const specIssues = validateAppSpec(spec, { cloud: false, prefix })
      errors.push(...specIssues.errors)
      warnings.push(...specIssues.warnings)
    }

    if (source === 'splunkbase') {
      warnings.push({
        field: `${prefix}.source`,
        message: 'Splunkbase installs require valid Splunkbase credentials configured on the Splunk instance',
        code: 'splunkbase_auth',
      })
    }

    // --- Version ------------------------------------------------------------
    const version = fields.version as string | undefined
    if (version !== undefined && typeof version !== 'string') {
      errors.push({ field: `${prefix}.version`, message: 'Version must be a string', code: 'invalid_type' })
    }
    const upgradePolicy = (fields.upgradePolicy as string | undefined) ?? 'manual'
    if (!UPGRADE_POLICIES.has(upgradePolicy)) {
      errors.push({ field: `${prefix}.upgradePolicy`, message: `Invalid upgrade policy "${upgradePolicy}"`, code: 'invalid_value' })
    }
    if (upgradePolicy === 'manual' && !isInline && (!version || version.trim().length === 0)) {
      warnings.push({
        field: `${prefix}.version`,
        message: 'No version pinned with a manual upgrade policy — the target will keep whatever version the package provides',
        code: 'no_version_pin',
      })
    }

    // --- Placement / lifecycle ----------------------------------------------
    const visibility = fields.visibility as string | undefined
    if (visibility !== undefined && !VISIBILITIES.has(visibility)) {
      errors.push({ field: `${prefix}.visibility`, message: `Invalid visibility "${visibility}"`, code: 'invalid_value' })
    }
    if (visibility === 'global') {
      warnings.push({
        field: `${prefix}.visibility`,
        message: 'Global sharing exposes this app\'s knowledge objects to every app — keep app-local unless intentionally shared',
        code: 'global_sharing',
      })
    }

    const state = fields.state as string | undefined
    if (state !== undefined && !STATES.has(state)) {
      errors.push({ field: `${prefix}.state`, message: `Invalid state "${state}"`, code: 'invalid_value' })
    }

    const targetTypes = fields.targetTypes as unknown
    if (targetTypes !== undefined && !Array.isArray(targetTypes)) {
      errors.push({ field: `${prefix}.targetTypes`, message: 'Target server types must be an array', code: 'invalid_type' })
    } else if (Array.isArray(targetTypes) && targetTypes.length === 0) {
      warnings.push({
        field: `${prefix}.targetTypes`,
        message: 'No target server types set — the app deploys to every matching connection for this configuration type',
        code: 'no_target_types',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
