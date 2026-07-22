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
import { readChangelogEntry } from './changelog.mjs'

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
// How the app's navigation (pages + configuration types) is laid out
const APP_NAV_LAYOUTS = ['tabs', 'sidebar']
// Configuration Canvas contract (mirrors the platform's canvas renderer)
const CANVAS_FIELD_TYPES = new Set([
  'text',
  'number',
  'select',
  'multiselect',
  'checkbox',
  'textarea',
  'tags',
  'password',
  'path',
  'files',
  'keyvalue',
  'remote-multiselect',
  'remote-select',
])
const SETTING_TYPES = new Set(['string', 'number', 'boolean', 'select'])
// Apps run in-process inside the platform server — modules that spawn
// processes, evaluate code, or reach into the runtime are not allowed.
const FORBIDDEN_MODULES = new Set([
  'child_process',
  'node:child_process',
  'vm',
  'node:vm',
  'worker_threads',
  'node:worker_threads',
  'cluster',
  'node:cluster',
])
// Filesystem/OS access is almost never needed by an API-driven app; flag it
// for review rather than banning it outright.
const REVIEW_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'os', 'node:os'])
// Dotfiles that are legitimately part of a repo checkout but never a package
const ALLOWED_DOTFILES = new Set(['.gitignore', '.npmrc', '.eslintrc', '.eslintrc.json', '.prettierrc'])
const TEXT_EXTENSIONS = new Set(['.yaml', '.yml', '.json', '.md'])
// High-confidence secret shapes (credential material must never ship in a package)
const SECRET_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'a private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key ID'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, 'a Slack token'],
  [/\bgh[pousr]_[0-9A-Za-z]{36,}\b/, 'a GitHub token'],
]
// Heuristic secret assignment (warning — review, may be a fixture)
const SECRET_ASSIGNMENT_RE =
  /\b(client_secret|api_?key|password|access_token|auth_token)\s*[:=]\s*['"][A-Za-z0-9+/_-]{20,}['"]/i
// Minimum SDK version whose ./client subpath (authFetch, host runtime) exists
const SDK_CLIENT_MIN = [1, 2]
// Minimum SDK version whose ./ui subpath (shared component library) exists
const SDK_UI_MIN = [2, 1]
// Navbar logos render at ~28px height — anything bigger than this is unoptimized
const MAX_LOGO_BYTES = 128 * 1024

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

  // Version consistency — the release tag, catalog entry, and npm metadata all
  // key off manifest.version; a diverging package.json version ships confusion.
  const pkgPath = path.join(appDir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg.version && manifest.version && pkg.version !== manifest.version) {
        err(
          `packaging: package.json version ("${pkg.version}") must equal manifest.version ` +
            `("${manifest.version}")`,
        )
      }
      if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
        warn(
          'packaging: package.json declares runtime "dependencies" — the platform only ' +
            'guarantees @veltrixsecops/app-sdk at runtime; bundle or vendor anything else',
        )
      }
    } catch (e) {
      err(`packaging: package.json is not valid JSON: ${e.message}`)
    }
  } else {
    warn('packaging: package.json is missing (needed for typecheck and version tracking)')
  }

  // Release notes — every version must record what changed so the in-product
  // upgrade banner can show it. Enforced once an app adopts a CHANGELOG.md
  // (a missing changelog is only a nudge, so apps can adopt it incrementally).
  const changelogPath = path.join(appDir, 'CHANGELOG.md')
  if (fs.existsSync(changelogPath)) {
    const entry = manifest.version ? readChangelogEntry(changelogPath, manifest.version) : null
    if (!entry) {
      err(
        `release notes: CHANGELOG.md has no entry for version ${manifest.version} — add a ` +
          `"## ${manifest.version} — <YYYY-MM-DD>" section describing the release`,
      )
    } else if (!entry.date) {
      warn(
        `release notes: CHANGELOG.md entry for ${manifest.version} has no date — add ` +
          '"— YYYY-MM-DD" to the heading so the catalog can record when it shipped',
      )
    }
  } else {
    warn(
      'release notes: add a CHANGELOG.md — version bumps should record what changed ' +
        '(surfaced in the in-product upgrade banner)',
    )
  }

  if (manifest.homepage && !/^https:\/\//.test(manifest.homepage)) {
    warn(`manifest.homepage should be an https:// URL (got "${manifest.homepage}")`)
  }
  if (typeof manifest.icon === 'string' && /[\\/]/.test(manifest.icon)) {
    // Path-style icons must exist; emoji icons pass through untouched
    requireFile(manifest.icon.replace(/^\.\//, ''), 'manifest.icon')
  }

  // Branding — rendered by the platform in the app navbar and as scoped CSS
  // variables; logos are served to browsers, so they are size/type/script
  // checked here rather than trusted.
  if (manifest.branding) {
    const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
    for (const key of ['primaryColor', 'accentColor']) {
      const value = manifest.branding[key]
      if (value !== undefined && !HEX_COLOR_RE.test(String(value))) {
        err(`branding: ${key} must be a #RGB or #RRGGBB hex color (got "${value}")`)
      }
    }
    for (const key of ['logo', 'logoDark']) {
      const ref = manifest.branding[key]
      if (ref === undefined) continue
      if (typeof ref !== 'string' || !ref.trim()) {
        err(`branding: ${key} must be a repo-relative file path`)
        continue
      }
      if (ref.split(/[\\/]/).includes('..')) {
        err(`branding: ${key} must not contain '..' path segments: "${ref}"`)
        continue
      }
      const ext = path.extname(ref).toLowerCase()
      if (ext !== '.svg' && ext !== '.png') {
        err(`branding: ${key} must be an .svg (preferred) or .png file (got "${ref}")`)
      }
      const full = path.join(appDir, ref.replace(/^\.\//, ''))
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        err(`branding: ${key} points to a missing file: "${ref}"`)
        continue
      }
      if (fs.statSync(full).size > MAX_LOGO_BYTES) {
        err(
          `branding: ${key} exceeds ${MAX_LOGO_BYTES / 1024} KB — navbar logos render at ~28px height; use a small optimized asset`,
        )
      }
      if (ext === '.svg') {
        const svg = fs.readFileSync(full, 'utf8')
        if (/<script|\bon[a-z]+\s*=|javascript:|<foreignObject/i.test(svg)) {
          err(`branding: ${key} SVG contains scripting or event handlers — not allowed in logos`)
        }
      }
    }
  }

  // Permissions
  if (!Array.isArray(manifest.permissions?.platform)) {
    err('manifest.permissions.platform must be an array (may be empty)')
  }
  if (!Array.isArray(manifest.permissions?.app)) {
    err('manifest.permissions.app must be an array (may be empty)')
  } else {
    const seenResources = new Set()
    manifest.permissions.app.forEach((p, i) => {
      if (!p?.resource) err(`permissions.app[${i}].resource is required`)
      if (!Array.isArray(p?.actions) || p.actions.length === 0) {
        err(`permissions.app[${i}].actions must be a non-empty array`)
      }
      if (p?.resource) {
        if (seenResources.has(p.resource)) {
          err(`permissions.app[${i}].resource "${p.resource}" is declared more than once`)
        }
        seenResources.add(p.resource)
      }
    })
  }

  // Settings — admins edit these through a generated form; a malformed
  // declaration renders as a broken control or silently drops the value.
  ;(manifest.settings ?? []).forEach((setting, i) => {
    const label = `settings[${i}]${setting?.key ? ` (${setting.key})` : ''}`
    if (!setting?.key || typeof setting.key !== 'string') err(`settings: ${label}.key is required`)
    if (!setting?.label) err(`settings: ${label}.label is required`)
    if (!SETTING_TYPES.has(setting?.type)) {
      err(`settings: ${label}.type must be one of ${[...SETTING_TYPES].join(', ')} (got "${setting?.type}")`)
    }
    if (setting?.type === 'select') {
      if (!Array.isArray(setting.options) || setting.options.length === 0) {
        err(`settings: ${label} is a select but declares no options`)
      } else if (
        setting.default !== undefined &&
        !setting.options.some((o) => o?.value === setting.default)
      ) {
        err(`settings: ${label}.default "${setting.default}" is not one of its option values`)
      }
    } else if (setting?.default !== undefined && setting?.type && SETTING_TYPES.has(setting.type)) {
      if (typeof setting.default !== setting.type) {
        err(
          `settings: ${label}.default must be a ${setting.type} (got ${typeof setting.default})`,
        )
      }
    }
  })
  {
    const keys = (manifest.settings ?? []).map((s) => s?.key).filter(Boolean)
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
    for (const key of new Set(dupes)) err(`settings: key "${key}" is declared more than once`)
  }

  // Database
  if (manifest.database) {
    if (!manifest.database.tablePrefix || !TABLE_PREFIX_RE.test(manifest.database.tablePrefix)) {
      err(`database.tablePrefix must match ${TABLE_PREFIX_RE} (got "${manifest.database.tablePrefix}")`)
    }
    if (manifest.database.isolation && !['shared', 'schema', 'database', 'external'].includes(manifest.database.isolation)) {
      err(`database.isolation must be one of shared|schema|database|external (got "${manifest.database.isolation}")`)
    }
    if (manifest.database.migrations) {
      const migDir = path.join(appDir, manifest.database.migrations)
      if (!fs.existsSync(migDir) || !fs.statSync(migDir).isDirectory()) {
        err(`database.migrations points to a missing directory: "${manifest.database.migrations}"`)
      } else {
        validateMigrationOwnership(migDir, manifest.database, err)
      }
    }
  }

  // Pipeline
  const configTypes = manifest.pipeline?.configurationTypes
  if (!Array.isArray(configTypes) || configTypes.length === 0) {
    err('manifest.pipeline.configurationTypes must contain at least one entry')
  } else {
    const seenConfigIds = new Set()
    configTypes.forEach((ct, i) => {
      const label = `configurationTypes[${i}]${ct?.id ? ` (${ct.id})` : ''}`
      if (!ct?.id) err(`${label}.id is required`)
      if (!ct?.name) err(`${label}.name is required`)
      if (ct?.id) {
        if (seenConfigIds.has(ct.id)) err(`${label}.id "${ct.id}" is declared more than once`)
        seenConfigIds.add(ct.id)
      }
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

      // Canvas + defaults schemas — a malformed template renders as a broken
      // editor for every user of the config type; catch it at validate time.
      const canvasShape = validateCanvasTemplate(appDir, ct?.canvasTemplate, label, err, warn)
      if (ct?.defaultConfig && canvasShape) {
        validateDefaultsFile(appDir, ct.defaultConfig, label, canvasShape, err, warn)
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
  if (
    manifest.client?.navLayout !== undefined &&
    !APP_NAV_LAYOUTS.includes(manifest.client.navLayout)
  ) {
    err(`client.navLayout must be one of ${APP_NAV_LAYOUTS.join(' | ')} (got "${manifest.client.navLayout}")`)
  }

  // --- App UI & navigation contract ---
  const declaredPermissions = new Set(
    (manifest.permissions?.app ?? []).flatMap((p) =>
      (p?.actions ?? []).map((a) => `${p.resource}:${a}`),
    ),
  )
  const pagePaths = new Set((manifest.client?.pages ?? []).map((p) => p?.path))
  // A `nav: 'tab'` page may parent either another declared page OR a
  // configuration type (rendered as an in-page tab beside "Configurations",
  // e.g. an "Index Defaults" page under `/config/indexes`).
  const configTypeParents = new Set(
    (manifest.pipeline?.configurationTypes ?? [])
      .map((ct) => ct?.id)
      .filter(Boolean)
      .map((id) => `/config/${id}`),
  )
  {
    const declared = (manifest.client?.pages ?? []).map((p) => p?.path).filter(Boolean)
    const dupes = declared.filter((p, i) => declared.indexOf(p) !== i)
    for (const p of new Set(dupes)) err(`client.pages path "${p}" is declared more than once`)
  }
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
    if (page?.parent && !pagePaths.has(page.parent) && !configTypeParents.has(page.parent)) {
      err(`${label}.parent "${page.parent}" does not match any declared page path or configuration type`)
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
  const textFiles = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      const rel = path.relative(appDir, full)
      // Symlinks can smuggle content from outside the app directory into a
      // package (or dangle after extraction) — never legitimate in an app.
      if (entry.isSymbolicLink()) {
        err(`security: symlinks are not allowed: ${rel}`)
        continue
      }
      if (entry.name.startsWith('.') && !ALLOWED_DOTFILES.has(entry.name)) {
        warn(`packaging: hidden ${entry.isDirectory() ? 'directory' : 'file'} "${rel}" — remove it or it ships in the package`)
        if (entry.isDirectory()) continue
      }
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const ext = path.extname(entry.name).toLowerCase()
      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        err(`Executable files are not allowed: ${rel}`)
      }
      totalBytes += fs.statSync(full).size
      if (CODE_EXTENSIONS.has(ext)) codeFiles.push(full)
      else if (TEXT_EXTENSIONS.has(ext)) textFiles.push(full)
    }
  }
  walk(appDir)

  if (totalBytes > MAX_PACKAGE_SIZE) {
    err(`App exceeds the 50 MB size limit (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`)
  }

  // --- Import boundaries + in-process safety --------------------------------
  // App code runs inside the platform server process; modules and constructs
  // that spawn processes, evaluate strings as code, or kill the process are
  // treated the way AppInspect treats them for Splunk Cloud vetting.
  //
  // EXCEPTION — apps/<app>/infra/** is out-of-process BYOI provisioning tooling
  // (the app's InfraSpec bring-up: OpenTofu drivers, ansible runners, health
  // gates). The platform's provisioning WORKER spawns these as child processes /
  // CI steps — exactly like it spawns tofu and ansible themselves — so they are
  // NOT in-process app code and are exempt from the spawn / process.exit /
  // node:fs rules. The genuine safety rules (no directory escape, no
  // @prisma/client, no eval/new Function, no shipped secrets) still apply.
  const IMPORT_RE = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g
  for (const file of codeFiles) {
    const relFile = path.relative(appDir, file)
    const isTestFile = /(^|[\\/])__tests__[\\/]/.test(relFile) || /\.test\.[a-z]+$/.test(relFile)
    // Top-level infra/ dir = out-of-process provisioning tooling (see above).
    const isProvisioning = /^infra[\\/]/.test(relFile)
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1]
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec)
        if (!resolved.startsWith(appDir + path.sep) && resolved !== appDir) {
          err(
            `${relFile} imports "${spec}" which escapes the app directory — ` +
              'apps may only import their own files and published packages',
          )
        }
      } else if (spec === '@prisma/client' || spec.startsWith('@prisma/')) {
        err(
          `${relFile} imports "${spec}" — apps must not depend on the platform's ` +
            'Prisma client. Use ctx.platform / ctx.db from @veltrixsecops/app-sdk instead.',
        )
      } else if (FORBIDDEN_MODULES.has(spec) && !isProvisioning) {
        err(`security: ${relFile} imports "${spec}" — apps run in-process and must not spawn processes or evaluate code`)
      } else if (REVIEW_MODULES.has(spec) && !isTestFile && !isProvisioning) {
        warn(`security: ${relFile} imports "${spec}" — filesystem/OS access is rarely needed by an API-driven app; expect review scrutiny`)
      }
    }

    if (isTestFile) continue
    if (/\beval\s*\(/.test(source)) {
      err(`security: ${relFile} uses eval() — string evaluation is not allowed in app code`)
    }
    if (/\bnew\s+Function\s*\(/.test(source)) {
      err(`security: ${relFile} uses new Function() — string evaluation is not allowed in app code`)
    }
    if (/\bprocess\.exit\s*\(/.test(source) && !isProvisioning) {
      err(`security: ${relFile} calls process.exit() — apps run inside the platform server and must never terminate the process`)
    }
  }

  // --- Package hygiene + secret scanning ------------------------------------
  for (const file of [...codeFiles, ...textFiles]) {
    const relFile = path.relative(appDir, file)
    if (relFile === 'package-lock.json') continue
    const source = fs.readFileSync(file, 'utf8')

    if (/^<{7} /m.test(source)) {
      err(`packaging: ${relFile} contains git merge-conflict markers`)
    }
    for (const [pattern, what] of SECRET_PATTERNS) {
      if (pattern.test(source)) {
        err(`security: ${relFile} appears to contain ${what} — credential material must never ship in an app`)
      }
    }
    const isTestFile = /(^|[\\/])__tests__[\\/]/.test(relFile) || /\.test\.[a-z]+$/.test(relFile)
    if (!isTestFile && SECRET_ASSIGNMENT_RE.test(source)) {
      warn(`security: ${relFile} assigns a long literal to a secret-named key — verify it is not a real credential`)
    }
  }

  // --- SDK version freshness --------------------------------------------------
  // Each React subpath was added in a specific SDK release — an app importing
  // one but declaring an older SDK version would typecheck against a package
  // that lacks it entirely (a confusing failure at `npm install` time, not a
  // clear "bump your SDK" message). Check every gated subpath the same way.
  const SDK_SUBPATH_MIN_VERSIONS = [
    // The client runtime contract (authFetch, host runtime shims).
    { specifier: '@veltrixsecops/app-sdk/client', min: SDK_CLIENT_MIN },
    // The shared component library (Button, Card, DataTable, ...).
    { specifier: '@veltrixsecops/app-sdk/ui', min: SDK_UI_MIN },
  ]
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      const declared =
        pkg.devDependencies?.['@veltrixsecops/app-sdk'] ?? pkg.dependencies?.['@veltrixsecops/app-sdk']
      const minMatch = typeof declared === 'string' && declared.match(/(\d+)\.(\d+)\.\d+/)
      const declaredVersion = minMatch ? [Number(minMatch[1]), Number(minMatch[2])] : null

      for (const { specifier, min } of SDK_SUBPATH_MIN_VERSIONS) {
        const usesSubpath = codeFiles.some((file) => fs.readFileSync(file, 'utf8').includes(specifier))
        if (!usesSubpath || !declaredVersion) continue
        const [major, minor] = declaredVersion
        if (major < min[0] || (major === min[0] && minor < min[1])) {
          warn(`packaging: app imports ${specifier} but declares "${declared}" — declare ^${min.join('.')}.0 or newer`)
        }
      }
    } catch {
      // package.json parse issues are reported above
    }
  }

  return { errors, warnings, manifest }
}

/**
 * Compile-check the app's client entry with the exact settings the packager
 * uses — a client that cannot bundle would fail at release time otherwise.
 * Async (runs esbuild); callers merge the result into the printed report.
 * No-op for apps without a client entry.
 */
export async function checkClientBundle(appDirArg, manifest) {
  const errors = []
  const warnings = []
  if (!manifest?.client?.entry) return { errors, warnings }

  let bundleAppClient
  try {
    ;({ bundleAppClient } = await import('./client-bundler.mjs'))
  } catch {
    warnings.push('client: bundle check skipped — esbuild is not installed')
    return { errors, warnings }
  }

  const appDir = path.resolve(appDirArg)
  try {
    const result = await bundleAppClient({
      appRoot: appDir,
      entry: manifest.client.entry,
      nodePaths: [path.join(appDir, 'node_modules')],
      write: false,
    })
    if (result === null) {
      errors.push(`client: client.entry "${manifest.client.entry}" did not resolve to a file`)
    }
  } catch (e) {
    errors.push(`client: bundle check failed — ${e.message}`)
  }
  return { errors, warnings }
}

// --- Canvas template + defaults schema validation -----------------------------

/**
 * Validate a canvas.yaml template's structure and return its shape for
 * defaults cross-checking. Two forms are accepted:
 *
 *   item:      (preferred) the template describes ONE object the config
 *              creates — one Splunk index, one CrowdStrike IOC. `groups` are
 *              purely presentational field groupings inside that one item, so
 *              the item is ONE FLAT RECORD of fields. The user adds N items.
 *              Shape: { kind: 'item', fieldKeys: Set<key> }
 *
 *   sections:  (legacy) each section IS one item, and its fields are that
 *              item's record. Shape: { kind: 'sections', sections: Map<name, Set<key>> }
 *
 * Both forms land on the same runtime snapshot (canvas.sections[] = items),
 * which is what every deploy/validate handler iterates.
 *
 * Returns null when the file is missing (already reported) or unusable.
 */
function validateCanvasTemplate(appDir, ref, label, err, warn) {
  if (typeof ref !== 'string' || !ref.trim()) return null
  const file = path.join(appDir, ref)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null

  let canvas
  try {
    canvas = yaml.load(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    err(`canvas: ${label} template is not valid YAML: ${e.message}`)
    return null
  }
  if (!canvas || typeof canvas !== 'object') {
    err(`canvas: ${label} template did not parse to an object`)
    return null
  }
  for (const key of ['id', 'name']) {
    if (!canvas[key]) warn(`canvas: ${label} template is missing "${key}"`)
  }

  const hasItem = canvas.item !== undefined && canvas.item !== null
  const hasSections = Array.isArray(canvas.sections) && canvas.sections.length > 0

  if (!hasItem && !hasSections) {
    err(
      `canvas: ${label} template must declare an "item" (with groups) or ` +
        'at least one legacy "section"',
    )
    return null
  }
  if (hasItem && canvas.sections !== undefined) {
    warn(
      `canvas: ${label} template declares both "item" and "sections" — "item" wins; ` +
        'remove the legacy "sections" block',
    )
  }
  return hasItem
    ? validateCanvasItem(canvas.item, label, err, warn)
    : validateCanvasSections(canvas.sections, label, err, warn)
}

/**
 * Validate the ITEM form. An item is one flat record: field keys are unique
 * across ALL of its groups (two groups both defining `name` would collide into
 * a single value at runtime).
 */
function validateCanvasItem(item, label, err, warn) {
  if (typeof item !== 'object' || Array.isArray(item)) {
    err(`canvas: ${label} item must be a mapping`)
    return null
  }
  if (item.label === undefined) {
    warn(`canvas: ${label} item is missing "label" — the UI shows it as "Add <label>"`)
  }
  if (item.repeatable !== undefined && typeof item.repeatable !== 'boolean') {
    err(`canvas: ${label} item.repeatable must be a boolean`)
  }
  for (const bound of ['minItems', 'maxItems']) {
    const value = item[bound]
    if (value === undefined) continue
    if (!Number.isInteger(value)) err(`canvas: ${label} item.${bound} must be an integer`)
    else if (value < 0) err(`canvas: ${label} item.${bound} must not be negative`)
  }
  if (
    Number.isInteger(item.minItems) &&
    Number.isInteger(item.maxItems) &&
    item.maxItems < item.minItems
  ) {
    err(`canvas: ${label} item.maxItems (${item.maxItems}) is less than minItems (${item.minItems})`)
  }

  if (!Array.isArray(item.groups) || item.groups.length === 0) {
    err(`canvas: ${label} item must declare at least one group`)
    return null
  }

  // key → field, across every group: an item is ONE record, not one per group
  const fields = new Map()
  item.groups.forEach((group, gi) => {
    const gLabel = `${label} item.groups[${gi}]${group?.name ? ` ("${group.name}")` : ''}`
    if (!group?.name) err(`canvas: ${gLabel} is missing "name"`)
    if (!Array.isArray(group?.fields) || group.fields.length === 0) {
      err(`canvas: ${gLabel} declares no fields`)
      return
    }
    group.fields.forEach((field, fi) => {
      const fLabel = `${gLabel}.fields[${fi}]${field?.key ? ` ("${field.key}")` : ''}`
      if (!field?.key) {
        err(`canvas: ${fLabel} is missing "key"`)
      } else if (fields.has(field.key)) {
        err(
          `canvas: ${fLabel} duplicates key "${field.key}" — an item is one flat record, ` +
            'so a key may appear in only one of its groups',
        )
      } else {
        fields.set(field.key, field)
      }
      validateCanvasField(field, fLabel, err, warn)
    })
  })

  // A field's visibleWhen must reference a sibling field key declared in the item.
  for (const [key, field] of fields) {
    const cond = field?.visibleWhen
    if (
      cond &&
      typeof cond === 'object' &&
      typeof cond.field === 'string' &&
      cond.field.trim() &&
      !fields.has(cond.field)
    ) {
      err(
        `canvas: ${label} field "${key}".visibleWhen.field "${cond.field}" does not match any ` +
          'field key declared in the item',
      )
    }
  }

  if (item.identityField !== undefined) {
    const id = item.identityField
    if (typeof id !== 'string' || !id.trim()) {
      err(`canvas: ${label} item.identityField must be the key of one of the item's fields`)
    } else if (!fields.has(id)) {
      err(
        `canvas: ${label} item.identityField "${id}" does not match any field key declared ` +
          "in the item's groups",
      )
    } else if (fields.get(id).required !== true && item.identityDerived !== true) {
      // `identityDerived: true` says the handler derives this value when the user
      // leaves it blank (e.g. a Splunk app named after its configuration), so an
      // empty identity is intended rather than an item the deploy will skip.
      warn(
        `canvas: ${label} item.identityField "${id}" should be required: true — deploy ` +
          'handlers skip any item whose identity field is empty. Set item.identityDerived: true ' +
          'if the handler derives it when blank.',
      )
    } else if (fields.get(id).required === true && item.identityDerived === true) {
      err(
        `canvas: ${label} item.identityDerived is true but identityField "${id}" is required — ` +
          'a derived identity must be optional for the user to leave blank',
      )
    }
  }

  return { kind: 'item', fieldKeys: new Set(fields.keys()) }
}

/** Validate the LEGACY sections form — each section is one item. */
function validateCanvasSections(sections, label, err, warn) {
  const shape = new Map()
  sections.forEach((section, si) => {
    const sLabel = `${label} section[${si}]${section?.name ? ` ("${section.name}")` : ''}`
    if (!section?.name) err(`canvas: ${sLabel} is missing "name"`)
    if (!Array.isArray(section?.fields) || section.fields.length === 0) {
      err(`canvas: ${sLabel} declares no fields`)
      return
    }
    const keys = new Set()
    section.fields.forEach((field, fi) => {
      const fLabel = `${sLabel}.fields[${fi}]${field?.key ? ` ("${field.key}")` : ''}`
      if (!field?.key) {
        err(`canvas: ${fLabel} is missing "key"`)
      } else if (keys.has(field.key)) {
        err(`canvas: ${fLabel} duplicates key "${field.key}" within its section`)
      } else {
        keys.add(field.key)
      }
      validateCanvasField(field, fLabel, err, warn)
    })
    if (section?.name) shape.set(section.name, keys)
  })
  return { kind: 'sections', sections: shape }
}

/** Per-field rules, shared by the item and legacy sections forms. */
function validateCanvasField(field, fLabel, err, warn) {
  if (!field?.label) warn(`canvas: ${fLabel} is missing "label"`)
  if (!CANVAS_FIELD_TYPES.has(field?.fieldType)) {
    err(
      `canvas: ${fLabel}.fieldType must be one of ${[...CANVAS_FIELD_TYPES].join(', ')} ` +
        `(got "${field?.fieldType}")`,
    )
  }

  if (field?.fieldType === 'select' || field?.fieldType === 'multiselect') {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      err(`canvas: ${fLabel} is a ${field.fieldType} but declares no options`)
    } else {
      field.options.forEach((option, oi) => {
        if (option?.label === undefined || option?.value === undefined) {
          err(`canvas: ${fLabel}.options[${oi}] needs both "label" and "value"`)
        }
      })
      // A multiselect's default is a list of option values; a select's is one
      const defaults =
        field.fieldType === 'multiselect' && Array.isArray(field.defaultValue)
          ? field.defaultValue
          : field.defaultValue === undefined
            ? []
            : [field.defaultValue]
      for (const value of defaults) {
        if (!field.options.some((o) => o?.value === value)) {
          err(`canvas: ${fLabel}.defaultValue "${value}" is not one of its option values`)
        }
      }
    }
  }
  if (field?.fieldType === 'number' && field.defaultValue !== undefined && typeof field.defaultValue !== 'number') {
    err(`canvas: ${fLabel}.defaultValue must be a number for a number field`)
  }
  if (field?.fieldType === 'checkbox' && field.defaultValue !== undefined && typeof field.defaultValue !== 'boolean') {
    err(`canvas: ${fLabel}.defaultValue must be a boolean for a checkbox field`)
  }

  const v = field?.validation
  if (v && typeof v === 'object') {
    if (v.pattern !== undefined) {
      try {
        new RegExp(v.pattern)
      } catch (e) {
        err(`canvas: ${fLabel}.validation.pattern is not a valid regex: ${e.message}`)
      }
    }
    for (const bound of ['min', 'max', 'minLength', 'maxLength']) {
      if (v[bound] !== undefined && typeof v[bound] !== 'number') {
        err(`canvas: ${fLabel}.validation.${bound} must be a number`)
      }
    }
    if (typeof v.min === 'number' && typeof v.max === 'number' && v.min > v.max) {
      err(`canvas: ${fLabel}.validation has min (${v.min}) greater than max (${v.max})`)
    }
  }

  // visibleWhen — conditional visibility keyed on a sibling field's value.
  // Shape only here; the sibling-key reference is checked in validateCanvasItem
  // (which knows every field key in the item).
  const vw = field?.visibleWhen
  if (vw !== undefined) {
    if (!vw || typeof vw !== 'object' || Array.isArray(vw)) {
      err(`canvas: ${fLabel}.visibleWhen must be an object, e.g. { field: "mode", equals: "json" }`)
    } else {
      if (typeof vw.field !== 'string' || !vw.field.trim()) {
        err(`canvas: ${fLabel}.visibleWhen.field must be the key of a sibling field`)
      }
      const hasEquals = vw.equals !== undefined
      const hasIn = vw.in !== undefined
      if (hasEquals === hasIn) {
        err(`canvas: ${fLabel}.visibleWhen must set exactly one of "equals" or "in"`)
      }
      if (hasIn && (!Array.isArray(vw.in) || vw.in.length === 0)) {
        err(`canvas: ${fLabel}.visibleWhen.in must be a non-empty array of values`)
      }
    }
  }

  // lockKeys — read-only keys (edit values only); only meaningful on keyvalue.
  if (field?.lockKeys !== undefined) {
    if (typeof field.lockKeys !== 'boolean') {
      err(`canvas: ${fLabel}.lockKeys must be a boolean`)
    } else if (field.lockKeys && field.fieldType !== 'keyvalue') {
      err(`canvas: ${fLabel}.lockKeys only applies to a "keyvalue" field (got "${field.fieldType}")`)
    }
  }
}

/**
 * Cross-check a defaults.yaml against the canvas template's shape.
 *   item form:     FLAT — { <fieldKey>: value } seeds every new item
 *   sections form: NESTED — { <sectionName>: { <fieldKey>: value } }
 */
function validateDefaultsFile(appDir, ref, label, canvasShape, err, warn) {
  const file = path.join(appDir, ref)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return

  let defaults
  try {
    defaults = yaml.load(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    err(`canvas: ${label} defaults file is not valid YAML: ${e.message}`)
    return
  }
  if (defaults == null) return // an empty defaults file is fine

  if (canvasShape.kind === 'item') {
    if (typeof defaults !== 'object' || Array.isArray(defaults)) {
      err(`canvas: ${label} defaults must be a flat mapping of field key → default value`)
      return
    }
    for (const key of Object.keys(defaults)) {
      if (!canvasShape.fieldKeys.has(key)) {
        warn(
          `canvas: ${label} defaults key "${key}" does not match any canvas field — an "item" ` +
            'template takes FLAT defaults ({ fieldKey: value }), not per-section defaults',
        )
      }
    }
    return
  }

  if (typeof defaults !== 'object' || Array.isArray(defaults)) {
    err(`canvas: ${label} defaults must be a mapping of section name → field defaults`)
    return
  }
  for (const [sectionName, fields] of Object.entries(defaults)) {
    const keys = canvasShape.sections.get(sectionName)
    if (!keys) {
      warn(`canvas: ${label} defaults section "${sectionName}" does not match any canvas section`)
      continue
    }
    if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) continue
    for (const key of Object.keys(fields)) {
      if (!keys.has(key)) {
        warn(`canvas: ${label} defaults key "${sectionName}.${key}" does not match any canvas field`)
      }
    }
  }
}

/**
 * Scan an app's SQL migrations for statements that reach outside the app's
 * namespace. Mirrors the platform's runtime ownership guard
 * (server app-engine migration-runner) so bad migrations fail at build time.
 */
const MIG_FORBIDDEN =
  /\bCREATE\s+(ROLE|USER|DATABASE|EXTENSION|SCHEMA)\b|\bDROP\s+(ROLE|USER|DATABASE|SCHEMA)\b|\bALTER\s+(ROLE|USER|DATABASE|SYSTEM)\b|\b(GRANT|REVOKE)\b|\bSET\s+ROLE\b|\bCOPY\b|\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i
const MIG_OWNED_DDL =
  /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|UNIQUE\s+INDEX|SEQUENCE|VIEW|MATERIALIZED\s+VIEW|TYPE|TRIGGER)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?("?[A-Za-z0-9_.]+"?)/i
const MIG_PROTECTED_SCHEMAS = new Set(['public', 'pg_catalog', 'information_schema', 'pg_toast'])

function clipSql(s) {
  return s.length > 120 ? `${s.slice(0, 117)}...` : s
}

function validateMigrationOwnership(migDir, database, err) {
  const isolation = database.isolation === 'schema' ? 'schema' : 'shared'
  const prefix = String(database.tablePrefix || '')
  let files
  try {
    files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()
  } catch {
    return
  }
  for (const file of files) {
    let sql
    try {
      sql = fs.readFileSync(path.join(migDir, file), 'utf8')
    } catch {
      continue
    }
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean)
    for (const st of statements) {
      const oneLine = st.replace(/\s+/g, ' ')
      if (MIG_FORBIDDEN.test(st)) {
        err(`migrations: ${file} has a statement an app may not run (roles/schemas/functions/grants): "${clipSql(oneLine)}"`)
        continue
      }
      for (const m of oneLine.matchAll(/(?:^|[\s("])("?[A-Za-z_][A-Za-z0-9_]*"?)\s*\.\s*"?[A-Za-z_]/g)) {
        const schema = m[1].replace(/^"(.*)"$/, '$1')
        if (isolation === 'shared' && MIG_PROTECTED_SCHEMAS.has(schema.toLowerCase())) {
          err(`migrations: ${file} may not reference schema "${schema}": "${clipSql(oneLine)}"`)
        }
      }
      if (isolation === 'shared') {
        const owned = MIG_OWNED_DDL.exec(st)
        if (owned) {
          const name = owned[1].split('.').pop().replace(/^"(.*)"$/, '$1')
          if (!prefix || !name.toLowerCase().includes(prefix.toLowerCase())) {
            err(`migrations: ${file} object "${name}" must be namespaced with tablePrefix "${prefix}": "${clipSql(oneLine)}"`)
          }
        }
      }
    }
  }
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
