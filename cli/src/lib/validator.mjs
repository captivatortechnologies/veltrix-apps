// ============================================================================
// Veltrix app validator (single source of truth)
//
// Used by the `veltrix validate` CLI command AND by this repo's CI via the
// thin wrapper in scripts/validate-app.mjs. Validates one app directory
// against the platform contract:
//   - manifest.yaml schema (id, version, pipeline, handlers, targets, ...)
//   - referenced files exist (handlers, templates, hooks, entries, migrations)
//   - security rules: no executables, 50 MB cap, no imports escaping the app
//     directory, no @prisma/client (apps must use the SDK contexts)
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const APP_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const TABLE_PREFIX_RE = /^[a-z][a-z0-9_]*_$/
const FORBIDDEN_EXTENSIONS = new Set(['.sh', '.bat', '.exe', '.cmd', '.ps1'])
const MAX_PACKAGE_SIZE = 50 * 1024 * 1024
const REQUIRED_HANDLERS = ['validate', 'deploy', 'rollback', 'healthCheck', 'getStatus']
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
// Extensionless manifest refs (handlers, entries) resolve like require() does
const RESOLVE_CANDIDATES = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.js']
const CATEGORIES = new Set(['SIEM', 'EDR', 'SOAR', 'IAM', 'NETWORK', 'CLOUD', 'COMPLIANCE', 'CUSTOM'])
// App UI & navigation contract (mirrors @veltrixsecops/app-sdk)
const APP_PAGE_LAYOUTS = ['standard', 'full-bleed', 'canvas']
const APP_PAGE_NAV = ['sidebar', 'tab', 'hidden']

export function validateApp(appDirArg) {
  const errors = []
  const warnings = []
  const err = (m) => errors.push(m)
  const warn = (m) => warnings.push(m)

  const appDir = path.resolve(appDirArg)
  const dirName = path.basename(appDir)

  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    return { errors: [`App directory not found: ${appDirArg}`], warnings }
  }

  const fileExists = (rel) =>
    RESOLVE_CANDIDATES.some((suffix) => {
      const p = path.join(appDir, rel + suffix)
      return fs.existsSync(p) && fs.statSync(p).isFile()
    })

  const requireFile = (rel, label) => {
    if (typeof rel !== 'string' || !rel.trim()) {
      err(`${label} is missing or empty`)
      return
    }
    if (rel.split(/[\\/]/).includes('..')) {
      err(`${label} must not contain '..' path segments: "${rel}"`)
      return
    }
    if (!fileExists(rel)) err(`${label} points to a missing file: "${rel}"`)
  }

  // --- Manifest ---------------------------------------------------------
  const manifestPath = path.join(appDir, 'manifest.yaml')
  if (!fs.existsSync(manifestPath)) {
    return { errors: [`manifest.yaml not found in ${appDirArg}`], warnings }
  }

  let manifest
  try {
    manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    return { errors: [`manifest.yaml is not valid YAML: ${e.message}`], warnings }
  }
  if (!manifest || typeof manifest !== 'object') {
    return { errors: ['manifest.yaml did not parse to an object'], warnings }
  }

  // Identity
  if (!manifest.id || !APP_ID_RE.test(manifest.id)) {
    err(`manifest.id must match ${APP_ID_RE} (got "${manifest.id}")`)
  } else if (manifest.id !== dirName && !dirName.startsWith('_')) {
    // _-prefixed directories (the _template) are scaffolding, not installable apps
    err(`manifest.id ("${manifest.id}") must equal the app directory name ("${dirName}")`)
  }
  for (const field of ['name', 'version', 'vendor', 'description', 'category']) {
    if (!manifest[field] || typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      err(`manifest.${field} is required`)
    }
  }
  if (manifest.version && !SEMVER_RE.test(manifest.version)) {
    err(`manifest.version must be semver (got "${manifest.version}")`)
  }
  if (manifest.category && !CATEGORIES.has(manifest.category)) {
    warn(`manifest.category "${manifest.category}" is not one of ${[...CATEGORIES].join(', ')}`)
  }
  if (!manifest.platform?.minVersion) warn('manifest.platform.minVersion is not set')

  // Permissions
  if (!Array.isArray(manifest.permissions?.platform)) {
    err('manifest.permissions.platform must be an array (may be empty)')
  }
  if (!Array.isArray(manifest.permissions?.app)) {
    err('manifest.permissions.app must be an array (may be empty)')
  } else {
    manifest.permissions.app.forEach((p, i) => {
      if (!p?.resource) err(`permissions.app[${i}].resource is required`)
      if (!Array.isArray(p?.actions) || p.actions.length === 0) {
        err(`permissions.app[${i}].actions must be a non-empty array`)
      }
    })
  }

  // Database
  if (manifest.database) {
    if (!manifest.database.tablePrefix || !TABLE_PREFIX_RE.test(manifest.database.tablePrefix)) {
      err(`database.tablePrefix must match ${TABLE_PREFIX_RE} (got "${manifest.database.tablePrefix}")`)
    }
    if (manifest.database.migrations) {
      const migDir = path.join(appDir, manifest.database.migrations)
      if (!fs.existsSync(migDir) || !fs.statSync(migDir).isDirectory()) {
        err(`database.migrations points to a missing directory: "${manifest.database.migrations}"`)
      }
    }
  }

  // Pipeline
  const configTypes = manifest.pipeline?.configurationTypes
  if (!Array.isArray(configTypes) || configTypes.length === 0) {
    err('manifest.pipeline.configurationTypes must contain at least one entry')
  } else {
    configTypes.forEach((ct, i) => {
      const label = `configurationTypes[${i}]${ct?.id ? ` (${ct.id})` : ''}`
      if (!ct?.id) err(`${label}.id is required`)
      if (!ct?.name) err(`${label}.name is required`)
      requireFile(ct?.canvasTemplate, `${label}.canvasTemplate`)
      if (ct?.defaultConfig) requireFile(ct.defaultConfig, `${label}.defaultConfig`)
      for (const h of REQUIRED_HANDLERS) {
        requireFile(ct?.handlers?.[h], `${label}.handlers.${h}`)
      }
      if (ct?.handlers?.driftDetect) {
        requireFile(ct.handlers.driftDetect, `${label}.handlers.driftDetect`)
      }
      if (!Array.isArray(ct?.targets?.componentTypes) || ct.targets.componentTypes.length === 0) {
        err(`${label}.targets.componentTypes must be a non-empty array`)
      }
    })
  }

  // --- Canonical layout conventions (warnings — see _template/README.md) ---
  // Everything for one configuration type is colocated in config-types/<id>/
  const stripRef = (p) => String(p ?? '').replace(/^\.\//, '')
  if (Array.isArray(configTypes)) {
    configTypes.forEach((ct) => {
      if (!ct?.id) return
      if (ct.canvasTemplate && stripRef(ct.canvasTemplate) !== `config-types/${ct.id}/canvas.yaml`) {
        warn(`layout: canvasTemplate for "${ct.id}" should be "config-types/${ct.id}/canvas.yaml" (got "${ct.canvasTemplate}")`)
      }
      if (ct.defaultConfig && stripRef(ct.defaultConfig) !== `config-types/${ct.id}/defaults.yaml`) {
        warn(`layout: defaultConfig for "${ct.id}" should be "config-types/${ct.id}/defaults.yaml" (got "${ct.defaultConfig}")`)
      }
      for (const [handler, ref] of Object.entries(ct.handlers ?? {})) {
        if (!ref) continue
        const expected = `config-types/${ct.id}/${handler}`
        if (stripRef(ref).replace(/\.(ts|js|mjs|cjs)$/, '') !== expected) {
          warn(`layout: handlers.${handler} for "${ct.id}" should be "${expected}" (got "${ref}")`)
        }
      }
    })
  }
  for (const [hook, ref] of Object.entries(manifest.hooks ?? {})) {
    if (ref && stripRef(ref).replace(/\.(ts|js|mjs|cjs)$/, '') !== `hooks/${hook}`) {
      warn(`layout: hooks.${hook} should be "hooks/${hook}" (got "${ref}")`)
    }
  }
  if (manifest.server?.entry && stripRef(manifest.server.entry).replace(/\.(ts|js)$/, '') !== 'server/index') {
    warn(`layout: server.entry should be "server/index" (got "${manifest.server.entry}")`)
  }
  if (manifest.client?.entry && stripRef(manifest.client.entry).replace(/\.(tsx|ts|jsx|js)$/, '') !== 'client/index') {
    warn(`layout: client.entry should be "client/index" (got "${manifest.client.entry}")`)
  }
  if (manifest.database?.migrations && stripRef(manifest.database.migrations).replace(/\/$/, '') !== 'migrations') {
    warn(`layout: database.migrations should be "migrations" (got "${manifest.database.migrations}")`)
  }
  if (!fs.existsSync(path.join(appDir, 'README.md'))) {
    warn('layout: add a README.md documenting what the app manages and its required credentials')
  }

  // Server / client / hooks
  requireFile(manifest.server?.entry, 'server.entry')
  const prefix = manifest.server?.routes?.prefix
  if (prefix && manifest.id && prefix !== `/api/apps/${manifest.id}`) {
    err(`server.routes.prefix must be "/api/apps/${manifest.id}" (got "${prefix}")`)
  }
  if (manifest.client?.entry) requireFile(manifest.client.entry, 'client.entry')

  // --- App UI & navigation contract ---
  const declaredPermissions = new Set(
    (manifest.permissions?.app ?? []).flatMap((p) =>
      (p?.actions ?? []).map((a) => `${p.resource}:${a}`),
    ),
  )
  const pagePaths = new Set((manifest.client?.pages ?? []).map((p) => p?.path))
  ;(manifest.client?.pages ?? []).forEach((page, i) => {
    const label = `client.pages[${i}]${page?.label ? ` (${page.label})` : ''}`
    if (!page?.path || !page.path.startsWith('/')) {
      err(`${label}.path must start with "/" (got "${page?.path}")`)
    }
    if (!page?.component) err(`${label}.component is required`)
    if (!page?.label) err(`${label}.label is required`)

    if (page?.layout && !APP_PAGE_LAYOUTS.includes(page.layout)) {
      err(`${label}.layout must be one of ${APP_PAGE_LAYOUTS.join(' | ')} (got "${page.layout}")`)
    }
    if (page?.nav && !APP_PAGE_NAV.includes(page.nav)) {
      err(`${label}.nav must be one of ${APP_PAGE_NAV.join(' | ')} (got "${page.nav}")`)
    }
    if (page?.nav === 'tab' && !page.parent) {
      err(`${label}.nav is "tab" so it must declare a "parent" page path`)
    }
    if (page?.parent && !pagePaths.has(page.parent)) {
      err(`${label}.parent "${page.parent}" does not match any declared page path`)
    }
    if (page?.order !== undefined && typeof page.order !== 'number') {
      err(`${label}.order must be a number`)
    }
    const rp = page?.requiresPermission
    if (rp) {
      if (!rp.resource || !rp.action) {
        err(`${label}.requiresPermission needs both "resource" and "action"`)
      } else if (!declaredPermissions.has(`${rp.resource}:${rp.action}`)) {
        err(
          `${label}.requiresPermission "${rp.resource}:${rp.action}" is not declared in ` +
            'permissions.app — a page cannot require a permission the app does not expose',
        )
      }
    }
    if (page?.sidebar !== undefined && page?.nav === undefined) {
      warn(`${label}: "sidebar" is deprecated — use nav: "${page.sidebar ? 'sidebar' : 'hidden'}"`)
    }
  })
  for (const [hook, rel] of Object.entries(manifest.hooks ?? {})) {
    requireFile(rel, `hooks.${hook}`)
  }

  // --- File-tree rules ----------------------------------------------------
  let totalBytes = 0
  const codeFiles = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const ext = path.extname(entry.name).toLowerCase()
      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        err(`Executable files are not allowed: ${path.relative(appDir, full)}`)
      }
      totalBytes += fs.statSync(full).size
      if (CODE_EXTENSIONS.has(ext)) codeFiles.push(full)
    }
  }
  walk(appDir)

  if (totalBytes > MAX_PACKAGE_SIZE) {
    err(`App exceeds the 50 MB size limit (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`)
  }

  // --- Import boundaries ----------------------------------------------------
  const IMPORT_RE = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g
  for (const file of codeFiles) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1]
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec)
        if (!resolved.startsWith(appDir + path.sep) && resolved !== appDir) {
          err(
            `${path.relative(appDir, file)} imports "${spec}" which escapes the app directory — ` +
              'apps may only import their own files and published packages',
          )
        }
      } else if (spec === '@prisma/client' || spec.startsWith('@prisma/')) {
        err(
          `${path.relative(appDir, file)} imports "${spec}" — apps must not depend on the platform's ` +
            'Prisma client. Use ctx.platform / ctx.db from @veltrixsecops/app-sdk instead.',
        )
      }
    }
  }

  return { errors, warnings, manifest }
}

/** Print one app's validation result. Returns true if it failed. */
export function printResults(name, { errors, warnings }) {
  for (const w of warnings) console.log(`  ⚠ [${name}] ${w}`)
  if (errors.length > 0) {
    for (const e of errors) console.error(`  ✖ [${name}] ${e}`)
    console.error(`✖ ${name}: ${errors.length} error(s), ${warnings.length} warning(s)`)
    return true
  }
  console.log(`✔ ${name}: valid (${warnings.length} warning(s))`)
  return false
}
