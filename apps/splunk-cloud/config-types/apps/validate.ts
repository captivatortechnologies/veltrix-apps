import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractAppSpec, parseConf, validateAppSpec, type AppPackageSpec } from '../../lib/splunkPackage'

/**
 * Validate Splunk Cloud private app / add-on configurations.
 *
 * Splunk Cloud has no route for arbitrary REST config writes: the app is BUILT
 * from the authored files, VETTED by AppInspect, and installed through ACS. So
 * everything AppInspect would reject is checked here — statically, with no
 * network call — because a package that fails vetting cannot be installed at
 * all, and finding that out at deploy time costs the user a full vetting cycle.
 *
 * Cloud rules are ERRORS here, where Enterprise treats several as warnings:
 *   - denied confs (outputs.conf, limits.conf, authentication.conf, ...)
 *   - indexes.conf — Cloud forbids creating indexes in an app; an add-on must
 *     REFERENCE an existing index (create it with the Index Configuration type)
 *   - a bare [http] stanza — it reconfigures the global HEC input
 *   - banned input stanzas (TCP/UDP/splunktcp, every Windows input, ...)
 *   - real-time searches, crons more frequent than every 5 minutes, index=*
 *   - metadata write access that omits sc_admin
 *
 * These live in lib/splunkPackage.ts (`validateAppSpec` with `cloud: true`),
 * which is mirrored verbatim from the Splunk Enterprise app; this handler adds
 * the canvas-level rules (identity, file layout, duplicate apps).
 */

/** App ids appear in filesystem paths and ACS URLs. */
const APP_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/
const MAX_APP_ID_LENGTH = 100

/** Top-level folders a package may ship. `local/` and `metadata/` are excluded on purpose. */
const APP_FOLDERS = new Set(['default', 'bin', 'lookups', 'static', 'lib', 'README'])
const FILE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

interface FileEntry {
  path?: string
  content?: string
}

export interface CloudAppSpec {
  sectionName: string
  appId: string
  label: string
  version: string
  spec: AppPackageSpec
}

/**
 * Each canvas section describes one private app. Shared with deploy / rollback /
 * healthCheck / driftDetect so all five agree on what the canvas declares.
 *
 * `[install] build` must increase on every release — the canvas version does
 * exactly that, so it is the build number.
 */
export function extractCloudAppSpecs(canvas: CanvasSnapshot): CloudAppSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const { spec } = extractAppSpec(fields, { build: canvas.version })
    return {
      sectionName: section.name,
      appId: spec.appId,
      label: spec.label,
      version: spec.version,
      spec,
    }
  })
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
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    if (!name) {
      errors.push({ field: `${prefix}.name`, message: 'App ID is required', code: 'required' })
    } else {
      if (!APP_ID_PATTERN.test(name)) {
        errors.push({
          field: `${prefix}.name`,
          message:
            'App ID must start with a letter and contain only letters, digits, ".", "_" and "-" — it is the package\'s top-level folder name',
          code: 'invalid_format',
        })
      }
      if (name.length > MAX_APP_ID_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `App ID must be ${MAX_APP_ID_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (appIds.has(name)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate app ID: "${name}"`, code: 'duplicate' })
      }
      appIds.add(name)
    }

    // --- File layout --------------------------------------------------------
    const appFiles = Array.isArray(fields.appFiles) ? (fields.appFiles as FileEntry[]) : []
    if (appFiles.length === 0) {
      errors.push({
        field: `${prefix}.appFiles`,
        message:
          'A Splunk Cloud app must be authored from files — there is no other install route (ACS installs a vetted package, it cannot write .conf stanzas)',
        code: 'required',
      })
    }

    const seenPaths = new Set<string>()
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

      const slash = path.indexOf('/')
      const folder = slash === -1 ? '' : path.slice(0, slash)
      const rest = slash === -1 ? '' : path.slice(slash + 1)

      // metadata/default.meta is generated; local/ is the user-owned override layer
      // (lib/splunkPackage reports both) — every other folder must be a real one.
      if (folder === 'local' || folder === 'metadata') {
        // Reported by extractAppSpec below with the precise reason.
      } else if (!slash || !APP_FOLDERS.has(folder)) {
        errors.push({
          field: fieldRef,
          message: `File "${path}" must live under a standard app folder (${[...APP_FOLDERS].join(', ')})`,
          code: 'invalid_path',
        })
        return
      } else if (!rest || !FILE_PATH_PATTERN.test(path)) {
        errors.push({ field: fieldRef, message: `Invalid file name in "${path}"`, code: 'invalid_format' })
        return
      }

      if (seenPaths.has(path)) {
        errors.push({ field: fieldRef, message: `Duplicate file path "${path}"`, code: 'duplicate' })
      }
      seenPaths.add(path)
    })

    // --- Package spec (identity, permissions, conf contents, buildability) ---
    //
    // The package is actually BUILT inside validateAppSpec, so an oversized
    // archive or a path that will not fit a tar header fails now rather than
    // half-way through a deploy. Nothing here touches the network.
    const { spec, issues } = extractAppSpec(fields, {
      build: ctx.canvas.version,
      prefix: `${prefix}.appFiles`,
    })
    errors.push(...issues.errors)
    warnings.push(...issues.warnings)

    const specIssues = validateAppSpec(spec, { cloud: true, prefix })
    errors.push(...specIssues.errors)
    warnings.push(...specIssues.warnings)

    // --- Cloud-specific canvas rules ----------------------------------------
    if (fields.visibility !== undefined && fields.visibility !== 'app' && fields.visibility !== 'global') {
      errors.push({
        field: `${prefix}.visibility`,
        message: `Invalid sharing "${String(fields.visibility)}" — must be "app" or "global"`,
        code: 'invalid_value',
      })
    }

    // A modular input needs its spec, or splunkd cannot read the input's settings.
    const shipsInputsSpec = spec.extraFiles.some((f) => /^README\/.*inputs\.conf\.spec$/i.test(f.path))
    if (declaresModularInput(spec) && !shipsInputsSpec) {
      warnings.push({
        field: `${prefix}.appFiles`,
        message:
          'This app looks like it declares a modular input but ships no README/inputs.conf.spec — without the spec Splunk cannot read the input\'s settings and AppInspect flags it',
        code: 'missing_inputs_spec',
      })
    }

    // Every deploy runs AppInspect, which is slow and rate-limited; a package
    // this large also risks the 128 MB ACS limit.
    if (spec.binScripts.length > 0) {
      warnings.push({
        field: `${prefix}.appFiles`,
        message:
          'This app ships bin/ scripts — AppInspect applies its Python and security checks to them, and any manual_check finding BLOCKS self-service install on Splunk Cloud (a Support case is then the only route)',
        code: 'bin_scripts_vetting',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Input schemes splunkd ships itself — anything else in inputs.conf is a MODULAR input. */
const BUILTIN_INPUT_SCHEMES = new Set([
  'monitor', 'batch', 'script', 'http', 'fschange', 'tcp', 'splunktcp', 'udp', 'fifo',
])

/**
 * True when inputs.conf declares a `[<scheme>://<name>]` stanza whose scheme is
 * not one splunkd provides — i.e. an input implemented by a bin/ script, which
 * only works if the package also ships README/inputs.conf.spec.
 */
function declaresModularInput(spec: AppPackageSpec): boolean {
  for (const conf of spec.confFiles) {
    if (conf.name.toLowerCase() !== 'inputs.conf') continue
    for (const stanza of parseConf(conf.content).stanzas) {
      const scheme = stanza.name.split('://')[0]?.trim().toLowerCase()
      if (scheme && scheme !== stanza.name.trim().toLowerCase() && !BUILTIN_INPUT_SCHEMES.has(scheme)) {
        return true
      }
    }
  }
  return false
}
