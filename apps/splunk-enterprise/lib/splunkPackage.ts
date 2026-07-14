// =============================================================================
// Splunk app / add-on packaging + static validation.
//
// A Splunk app is nothing more than a directory of .conf files (plus optional
// bin/ scripts) shipped as a gzipped tar (.spl / .tar.gz). This module turns
// one canvas item into that archive and enforces every rule that can be
// checked statically before an install is attempted.
//
// Handlers run IN-PROCESS inside the platform's Node runtime, so everything
// here happens in memory:
//   - no shelling out to `tar` or the `splunk` CLI (child_process is banned)
//   - no writing to the Splunk host's filesystem
//   - the tar writer is hand-rolled (ustar, 512-byte headers) so the package
//     carries EXPLICIT unix modes; Windows' default modes fail AppInspect.
//
// The archive is byte-reproducible: entries are sorted, mtime is pinned and
// Node's gzip does not stamp a timestamp. The same canvas item therefore
// always produces the same sha256, which is what lets deploy verify that a
// remotely-hosted package really is the one this canvas describes.
//
// NOTE: this file is mirrored verbatim in apps/splunk-cloud/lib/splunkPackage.ts.
// Apps are bundled independently and cannot import across app boundaries, so
// the two copies must be kept in sync.
// =============================================================================

import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

// --- Package model -----------------------------------------------------------

/** One file that lands in <app_id>/default/. */
export interface ConfFile {
  /** File name including the .conf suffix, e.g. "props.conf". */
  name: string
  content: string
}

/** One file that lands in <app_id>/bin/ (mode 700). */
export interface BinScript {
  name: string
  content: string
}

/** A file placed verbatim under the app root, e.g. "README/inputs.conf.spec". */
export interface PackagedFile {
  /** Path relative to the app root — never starts with a slash. */
  path: string
  content: string
}

/** One Splunk app/add-on, derived from one canvas item. */
export interface AppPackageSpec {
  appId: string
  label: string
  version: string
  author: string
  description: string
  /** [ui] is_visible — false for an add-on (TA), true for a full app with a UI. */
  visible: boolean
  /** [install] build — a positive integer that must increase on every release. */
  build: number
  confFiles: ConfFile[]
  binScripts: BinScript[]
  /**
   * Anything else that ships under the app root verbatim — README/inputs.conf.spec
   * (required for a modular input), lookups/*.csv, default/data/ui/**. Without
   * these a modular input cannot work, so the package must be able to carry them.
   */
  extraFiles: PackagedFile[]
  /** The `[]` stanza's export in metadata/default.meta. */
  globalExport: 'none' | 'system'
  readRoles: string[]
  writeRoles: string[]
  /** Object types promoted to `export = system` in metadata/default.meta. */
  exportedObjects: string[]
  /** Content that appeared before the first ">>> file:" marker (a user error). */
  strayConfContent: boolean
  strayScriptContent: boolean
}

// --- Limits and rule tables --------------------------------------------------

/** Splunk Cloud rejects packages larger than this; Enterprise has no hard cap. */
export const MAX_PACKAGE_BYTES = 128 * 1024 * 1024

export const MAX_APP_ID_LENGTH = 100
export const MIN_LABEL_LENGTH = 5
export const MAX_LABEL_LENGTH = 80
export const MAX_DESCRIPTION_LENGTH = 200

const APP_ID_CHARSET = /^[A-Za-z0-9._-]+$/
const SEMVER_3_PART = /^\d+\.\d+\.\d+$/
const CONF_FILE_NAME = /^[A-Za-z0-9_-]+\.conf$/
const SCRIPT_FILE_NAME = /^[A-Za-z0-9_.-]+$/

/** Reserved on Windows regardless of extension — a folder with this name cannot be created. */
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/**
 * Confs that ship with Splunk. Anything NOT in this list is a CUSTOM conf and
 * needs a `[triggers] reload.<name> = simple` entry in app.conf — without one,
 * installing the app forces a full splunkd RESTART every single time.
 * Conversely a trigger must NEVER be emitted for a standard conf.
 */
const STANDARD_CONFS = new Set([
  'alert_actions', 'app', 'audit', 'authentication', 'authorize', 'checklist',
  'collections', 'commands', 'crawl', 'datamodels', 'datatypesbnf',
  'default-mode', 'deployment', 'deploymentclient', 'distsearch',
  'event_renderers', 'eventdiscoverer', 'eventtypes', 'fields', 'global-banner',
  'health', 'indexes', 'inputs', 'limits', 'literals', 'macros', 'messages',
  'migration', 'multikv', 'outputs', 'passwords', 'pdf_server',
  'procmon-filters', 'props', 'pubsub', 'restmap', 'savedsearches',
  'searchbnf', 'segmenters', 'server', 'serverclass', 'source-classifier',
  'sourcetypes', 'splunk-launch', 'tags', 'telemetry', 'times',
  'transactiontypes', 'transforms', 'ui-prefs', 'ui-tour', 'user-seed',
  'viewstates', 'visualizations', 'web', 'wmi', 'workflow_actions',
])

/**
 * We generate these ourselves — a user-supplied copy would silently lose the
 * required [id]/[launcher]/[package]/[install]/[ui] contract.
 */
const RESERVED_CONFS = new Set(['app.conf'])

/**
 * Confs Splunk Cloud rejects outright during vetting. This is the subset we
 * are confident about; AppInspect remains the authority (and the Cloud deploy
 * handler actually runs it), so this list fails fast rather than pretending to
 * be exhaustive.
 */
const CLOUD_DENIED_CONFS = new Set([
  'outputs.conf', 'limits.conf', 'passwords.conf', 'deploymentclient.conf',
  'serverclass.conf', 'deployment.conf', 'authentication.conf',
  'authorize.conf', 'crawl.conf', 'datatypesbnf.conf', 'default-mode.conf',
  'distsearch.conf', 'instance.cfg', 'literals.conf', 'messages.conf',
  'migration.conf', 'pdf_server.conf', 'procmon-filters.conf', 'pubsub.conf',
  'segmenters.conf', 'source-classifier.conf', 'sourcetypes.conf',
  'splunk-launch.conf', 'telemetry.conf', 'user-seed.conf', 'wmi.conf',
])

/** web.conf is allowed on Cloud only for these stanza prefixes. */
const CLOUD_WEB_CONF_ALLOWED = [/^endpoint:/i, /^expose:/i]

/**
 * server.conf is allowed on Cloud only for shclustering conf_replication_include
 * keys and diag EXCLUDE keys.
 */
const CLOUD_SERVER_CONF_ALLOWED: Array<{ stanza: RegExp; keys: RegExp }> = [
  { stanza: /^shclustering$/i, keys: /^conf_replication_include\./i },
  { stanza: /^diag$/i, keys: /^EXCLUDE-/i },
]

/** Input stanzas Splunk Cloud forbids — data must arrive via HEC or a forwarder. */
const CLOUD_BANNED_INPUT_STANZAS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /^tcp(-ssl)?:\/\//i, what: 'raw TCP inputs' },
  { pattern: /^udp:\/\//i, what: 'UDP inputs' },
  { pattern: /^splunktcp(-ssl)?(:\/\/|$)/i, what: 'splunktcp inputs' },
  { pattern: /^WinEventLog(:\/\/|$)/i, what: 'Windows Event Log inputs' },
  { pattern: /^perfmon:\/\//i, what: 'Windows perfmon inputs' },
  { pattern: /^WinRegMon:\/\//i, what: 'Windows registry monitor inputs' },
  { pattern: /^WinHostMon:\/\//i, what: 'Windows host monitor inputs' },
  { pattern: /^WinPrintMon:\/\//i, what: 'Windows print monitor inputs' },
  { pattern: /^WinNetMon:\/\//i, what: 'Windows network monitor inputs' },
  { pattern: /^admon:\/\//i, what: 'Active Directory monitor inputs' },
  { pattern: /^MonitorNoHandle:\/\//i, what: 'MonitorNoHandle inputs' },
  { pattern: /^powershell2?:\/\//i, what: 'PowerShell inputs' },
]

/** Directory names / patterns that must never reach the archive. */
const EXCLUDED_PACKAGE_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^__MACOSX/i, why: '__MACOSX metadata' },
  { pattern: /\.pyc$/i, why: 'compiled Python (.pyc)' },
  { pattern: /^\./, why: 'a dotfile' },
  { pattern: /\s/, why: 'a space in the file name' },
]

/** A leading absolute path in a conf value — never portable, always rejected. */
const LEADING_ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/

/** An absolute path embedded mid-value — often a legitimate regex, so only warned about. */
const EMBEDDED_ABSOLUTE_PATH = /(^|[\s(|,="'])(\/(?:etc|var|opt|usr|home|tmp|root|mnt|srv)\/|[A-Za-z]:[\\/])/

// --- Conf parsing ------------------------------------------------------------

export interface ConfKey {
  key: string
  value: string
  line: number
}

export interface ConfStanza {
  name: string
  line: number
  keys: ConfKey[]
}

export interface ParsedConf {
  stanzas: ConfStanza[]
  /** Keys that appear before any stanza header. */
  preamble: ConfKey[]
}

/**
 * Parse a .conf file into stanzas and keys. Comments and blank lines are
 * dropped; line continuations (a trailing "\") are consumed so a continued
 * value is not mistaken for a new key.
 */
export function parseConf(content: string): ParsedConf {
  const stanzas: ConfStanza[] = []
  const preamble: ConfKey[] = []
  let current: ConfStanza | null = null
  let continuing = false

  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const lineNo = i + 1

    if (continuing) {
      continuing = raw.trimEnd().endsWith('\\')
      continue
    }

    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue

    const stanzaMatch = /^\[(.*)\]$/.exec(line)
    if (stanzaMatch) {
      current = { name: stanzaMatch[1], line: lineNo, keys: [] }
      stanzas.push(current)
      continue
    }

    const eq = line.indexOf('=')
    if (eq > 0) {
      const entry: ConfKey = {
        key: line.slice(0, eq).trim(),
        value: line.slice(eq + 1).trim(),
        line: lineNo,
      }
      if (current) current.keys.push(entry)
      else preamble.push(entry)
      continuing = raw.trimEnd().endsWith('\\')
    }
  }

  return { stanzas, preamble }
}

/** "props.conf" → "props" */
export function confBaseName(fileName: string): string {
  return fileName.replace(/\.conf$/i, '')
}

/** A conf Splunk does not ship — it needs a [triggers] reload entry. */
export function isCustomConf(fileName: string): boolean {
  return !STANDARD_CONFS.has(confBaseName(fileName).toLowerCase())
}

// --- Multi-file textarea blobs -----------------------------------------------

const FILE_MARKER = /^\s*>>>\s*file:\s*(.+?)\s*$/i

export interface MultiFileBlob {
  files: Array<{ name: string; content: string }>
  /** Non-blank content that appeared before the first marker — always a mistake. */
  preamble: string
}

/**
 * Split a textarea that carries several files, delimited by lines of the form
 *
 *   >>> file: my_custom.conf
 *
 * The marker cannot collide with conf syntax (a conf line is a `[stanza]`, a
 * `key = value`, or a `#` comment), so no escaping is needed.
 */
export function splitMultiFileBlob(blob: string): MultiFileBlob {
  const files: Array<{ name: string; content: string }> = []
  const preambleLines: string[] = []
  let currentName: string | null = null
  let currentLines: string[] = []

  const flush = () => {
    if (currentName !== null) {
      files.push({ name: currentName, content: currentLines.join('\n') })
    }
    currentName = null
    currentLines = []
  }

  for (const raw of blob.split(/\r?\n/)) {
    const marker = FILE_MARKER.exec(raw)
    if (marker) {
      flush()
      currentName = marker[1].trim()
      continue
    }
    if (currentName === null) preambleLines.push(raw)
    else currentLines.push(raw)
  }
  flush()

  return { files, preamble: preambleLines.join('\n').trim() }
}

// --- Canvas item → spec ------------------------------------------------------

/** One entry of the `appFiles` canvas field: a folder-qualified path and its content. */
export interface AppFileEntry {
  path?: string
  content?: string
}

export interface ExtractedSpec {
  spec: AppPackageSpec
  /** Problems with the declared LAYOUT — a folder we must not ship, a generated file. */
  issues: SpecIssues
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Accept a tags/multiselect array or a comma/newline separated string. */
function toList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value.split(/[,\n]/).map((v) => v.trim()).filter((v) => v.length > 0)
  }
  return []
}

/**
 * Build the package spec from one canvas item.
 *
 * The `appFiles` field carries folder-qualified paths, so the folder decides
 * where a file lands: `default/*.conf` are conf files, `bin/*` are scripts
 * (mode 700), and everything else ships verbatim (README/inputs.conf.spec,
 * lookups/, default/data/ui/).
 *
 * `[install] build` must increase on every release; the canvas version does
 * exactly that, so the caller passes it in.
 */
export function extractAppSpec(
  fields: Record<string, unknown>,
  options: { build: number; prefix?: string },
): ExtractedSpec {
  const prefix = options.prefix ?? 'appFiles'
  const errors: SpecIssue[] = []
  const warnings: SpecIssue[] = []

  const confFiles: ConfFile[] = []
  const binScripts: BinScript[] = []
  const extraFiles: PackagedFile[] = []
  let shipsUi = false

  const entries = Array.isArray(fields.appFiles) ? (fields.appFiles as AppFileEntry[]) : []
  for (const entry of entries) {
    const path = str(entry?.path).replace(/^\/+/, '')
    if (!path) continue
    const content = typeof entry?.content === 'string' ? entry.content : ''

    const slash = path.indexOf('/')
    const folder = slash === -1 ? '' : path.slice(0, slash)
    const rest = slash === -1 ? path : path.slice(slash + 1)

    // local/ is the user's own override layer: it survives upgrades and shadows
    // whatever we ship, so a package must never carry it.
    if (folder === 'local') {
      errors.push({
        field: `${prefix}.${path}`,
        message:
          'local/ cannot be packaged — it is the user-owned override layer, it shadows default/ and survives upgrades. Move this file to default/.',
        code: 'local_in_package',
      })
      continue
    }

    if (folder === 'bin') {
      if (rest) binScripts.push({ name: rest, content })
      continue
    }

    // app.conf and default.meta are rendered from the canvas fields — an authored
    // copy would be silently overwritten, so say so rather than drop it quietly.
    if (path === 'default/app.conf' || path === 'metadata/default.meta') {
      warnings.push({
        field: `${prefix}.${path}`,
        message: `${path} is generated from this item's identity, sharing and permissions — the authored file is ignored.`,
        code: 'generated_file_ignored',
      })
      continue
    }

    const isTopLevelConf =
      (folder === 'default' || folder === '') && rest.endsWith('.conf') && !rest.includes('/')
    if (isTopLevelConf) {
      confFiles.push({ name: rest, content })
      continue
    }

    if (path.startsWith('default/data/ui/')) shipsUi = true
    extraFiles.push({ path, content })
  }

  const readRoles = toList(fields.readRoles)
  const writeRoles = toList(fields.writeRoles)

  const spec: AppPackageSpec = {
    appId: str(fields.name),
    label: str(fields.label),
    version: str(fields.version),
    author: str(fields.author) || 'Veltrix',
    description: str(fields.description),
    // An add-on (TA) is invisible; only an app that ships views is visible.
    visible: shipsUi,
    build: options.build,
    confFiles,
    binScripts,
    extraFiles,
    // The canvas' sharing choice is exactly the export scope of the app's objects.
    globalExport: fields.visibility === 'global' ? 'system' : 'none',
    readRoles: readRoles.length > 0 ? readRoles : ['*'],
    writeRoles: writeRoles.length > 0 ? writeRoles : ['admin', 'sc_admin'],
    exportedObjects: toList(fields.exportedObjects),
    strayConfContent: false,
    strayScriptContent: false,
  }

  return { spec, issues: { errors, warnings } }
}

// --- Conf rendering ----------------------------------------------------------

/** Conf values are single-line; a textarea invites newlines, so collapse them. */
function singleLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim()
}

/** LF endings + a trailing newline, so a package built on Windows matches one built on Linux. */
function normalizeText(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  return normalized.length > 0 ? `${normalized}\n` : ''
}

/**
 * Render <app_id>/default/app.conf.
 *
 * `install_source_checksum` is deliberately never emitted — splunkd populates
 * it on install and a hand-written value corrupts upgrade detection.
 */
export function renderAppConf(spec: AppPackageSpec): string {
  const lines: string[] = [
    '# Generated by Veltrix from the configuration canvas — do not edit by hand.',
    '',
    '[id]',
    // [id] name MUST equal the folder name AND [package] id;
    // [id] version MUST equal [launcher] version.
    `name = ${spec.appId}`,
    `version = ${spec.version}`,
    '',
    '[launcher]',
    `version = ${spec.version}`,
    `author = ${spec.author}`,
    `description = ${singleLine(spec.description)}`,
    '',
    '[package]',
    `id = ${spec.appId}`,
    // Private app — it is not on Splunkbase, so Splunk must not poll for updates.
    'check_for_updates = false',
    '',
    '[install]',
    `build = ${spec.build}`,
    'is_configured = false',
    '',
    '[ui]',
    // 0 for an add-on (TA): it contributes knowledge, not a UI.
    `is_visible = ${spec.visible ? 1 : 0}`,
    // Required even for an invisible TA.
    `label = ${spec.label}`,
  ]

  // A custom conf without a reload trigger forces a full splunkd restart on
  // every install. Standard confs already reload themselves and must NOT get one.
  const customConfs = spec.confFiles
    .map((c) => confBaseName(c.name))
    .filter((base) => isCustomConf(`${base}.conf`))
    .sort()

  if (customConfs.length > 0) {
    lines.push('', '[triggers]')
    for (const base of customConfs) lines.push(`reload.${base} = simple`)
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * Render <app_id>/metadata/default.meta.
 *
 * The `[]` stanza sets the app-wide default: readable by everyone, writable by
 * admin AND sc_admin (sc_admin is mandatory on Splunk Cloud), and NOT exported.
 * Object types are then promoted to `export = system` individually.
 */
export function renderDefaultMeta(spec: AppPackageSpec): string {
  const lines: string[] = [
    '# Generated by Veltrix from the configuration canvas — do not edit by hand.',
    '',
    '[]',
    `access = read : [ ${spec.readRoles.join(', ')} ], write : [ ${spec.writeRoles.join(', ')} ]`,
    `export = ${spec.globalExport}`,
  ]

  for (const object of [...spec.exportedObjects].sort()) {
    lines.push('', `[${object}]`, 'export = system')
  }

  lines.push('')
  return lines.join('\n')
}

// --- Tar (ustar) writer ------------------------------------------------------

const BLOCK_SIZE = 512

/**
 * Fixed mtime (2020-01-01T00:00:00Z) so the archive is byte-reproducible.
 * Node's gzip does not stamp a timestamp into the header, so the whole .tar.gz
 * is a pure function of the spec — which is what makes the sha256 meaningful.
 */
const TAR_MTIME = 1_577_836_800

/**
 * Explicit modes. Windows has no unix permission bits, so a naive packager
 * emits 0 or 0o666 and AppInspect fails the package. These are the modes
 * Splunk expects.
 */
export const MODE_DIR = 0o700
export const MODE_FILE = 0o600
export const MODE_SCRIPT = 0o700

export interface TarEntry {
  path: string
  type: 'file' | 'dir'
  mode: number
  content?: Buffer
}

function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const digits = Math.floor(value).toString(8)
  if (digits.length > length - 1) {
    throw new Error(`Value ${value} does not fit in a ${length}-byte octal tar field`)
  }
  buf.write(`${digits.padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

/**
 * ustar splits a long path into a 155-byte prefix and a 100-byte name at a
 * "/" boundary. Anything that still will not fit is a hard error — better to
 * fail loudly than to emit an archive Splunk silently truncates.
 */
function splitUstarPath(fullPath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(fullPath) <= 100) return { name: fullPath, prefix: '' }

  const parts = fullPath.split('/')
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/')
    const name = parts.slice(i).join('/')
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix }
    }
  }
  throw new Error(`Path is too long for the tar (ustar) format: "${fullPath}"`)
}

function tarHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE)
  const isDir = entry.type === 'dir'
  const fullPath = isDir && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path
  const { name, prefix } = splitUstarPath(fullPath)

  header.write(name, 0, 100, 'utf8')
  writeOctal(header, entry.mode & 0o7777, 100, 8)
  writeOctal(header, 0, 108, 8) // uid — 0 so the archive is host-independent
  writeOctal(header, 0, 116, 8) // gid
  writeOctal(header, size, 124, 12)
  writeOctal(header, TAR_MTIME, 136, 12)
  header.write('        ', 148, 8, 'ascii') // checksum placeholder: 8 spaces
  header.write(isDir ? '5' : '0', 156, 1, 'ascii') // typeflag
  header.write('ustar\0', 257, 6, 'latin1')
  header.write('00', 263, 2, 'ascii')
  header.write('root', 265, 32, 'utf8') // uname
  header.write('root', 297, 32, 'utf8') // gname
  writeOctal(header, 0, 329, 8) // devmajor
  writeOctal(header, 0, 337, 8) // devminor
  if (prefix) header.write(prefix, 345, 155, 'utf8')

  // Checksum = sum of all header bytes with the checksum field read as spaces,
  // written back as 6 octal digits, a NUL and a space.
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')

  return header
}

/** Serialize entries into an uncompressed ustar archive. */
export function createTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = []

  for (const entry of entries) {
    const content = entry.type === 'dir' ? Buffer.alloc(0) : entry.content ?? Buffer.alloc(0)
    chunks.push(tarHeader(entry, content.length))
    if (content.length > 0) {
      chunks.push(content)
      const padding = (BLOCK_SIZE - (content.length % BLOCK_SIZE)) % BLOCK_SIZE
      if (padding > 0) chunks.push(Buffer.alloc(padding))
    }
  }

  // Two zero blocks terminate a tar archive.
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2))
  return Buffer.concat(chunks)
}

// --- Package build -----------------------------------------------------------

export interface BuiltPackage {
  fileName: string
  bytes: Buffer
  sha256: string
  sizeBytes: number
  /** Archive members, in order — exposed so tests and drift checks can inspect them. */
  entries: TarEntry[]
  appConf: string
  defaultMeta: string
}

/**
 * Build the .spl (gzipped ustar tar) for one app spec, entirely in memory.
 *
 * Layout — exactly ONE top-level directory, named identically to the app id:
 *   <app_id>/default/app.conf          (generated)
 *   <app_id>/default/<user confs>      (never local/ — that is user-owned and survives upgrade)
 *   <app_id>/metadata/default.meta     (generated)
 *   <app_id>/bin/<scripts>             (optional, mode 700)
 */
export function buildAppPackage(spec: AppPackageSpec): BuiltPackage {
  const appConf = renderAppConf(spec)
  const defaultMeta = renderDefaultMeta(spec)

  const entries: TarEntry[] = [
    { path: `${spec.appId}/`, type: 'dir', mode: MODE_DIR },
    { path: `${spec.appId}/default/`, type: 'dir', mode: MODE_DIR },
    {
      path: `${spec.appId}/default/app.conf`,
      type: 'file',
      mode: MODE_FILE,
      content: Buffer.from(appConf, 'utf8'),
    },
  ]

  for (const conf of [...spec.confFiles].sort((a, b) => a.name.localeCompare(b.name))) {
    entries.push({
      path: `${spec.appId}/default/${conf.name}`,
      type: 'file',
      mode: MODE_FILE,
      content: Buffer.from(normalizeText(conf.content), 'utf8'),
    })
  }

  entries.push({ path: `${spec.appId}/metadata/`, type: 'dir', mode: MODE_DIR })
  entries.push({
    path: `${spec.appId}/metadata/default.meta`,
    type: 'file',
    mode: MODE_FILE,
    content: Buffer.from(defaultMeta, 'utf8'),
  })

  if (spec.binScripts.length > 0) {
    entries.push({ path: `${spec.appId}/bin/`, type: 'dir', mode: MODE_DIR })
    for (const script of [...spec.binScripts].sort((a, b) => a.name.localeCompare(b.name))) {
      entries.push({
        path: `${spec.appId}/bin/${script.name}`,
        type: 'file',
        mode: MODE_SCRIPT,
        content: Buffer.from(normalizeText(script.content), 'utf8'),
      })
    }
  }

  // Everything else that ships verbatim (README/inputs.conf.spec, lookups/, static/,
  // default/data/ui/). Parent directories are emitted once, before their contents.
  const dirs = new Set(entries.filter((e) => e.type === 'dir').map((e) => e.path))
  for (const file of [...spec.extraFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = file.path.split('/')
    let dir = `${spec.appId}/`
    for (const segment of segments.slice(0, -1)) {
      dir += `${segment}/`
      if (!dirs.has(dir)) {
        dirs.add(dir)
        entries.push({ path: dir, type: 'dir', mode: MODE_DIR })
      }
    }
    entries.push({
      path: `${spec.appId}/${file.path}`,
      type: 'file',
      mode: MODE_FILE,
      content: Buffer.from(normalizeText(file.content), 'utf8'),
    })
  }

  const tar = createTar(entries)
  const bytes = gzipSync(tar, { level: 9 })

  return {
    fileName: `${spec.appId}-${spec.version}.tar.gz`,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    entries,
    appConf,
    defaultMeta,
  }
}

// --- Install upload ----------------------------------------------------------

export interface InstallUpload {
  body: Buffer
  contentType: string
}

/**
 * Encode a built package as the multipart upload `POST /services/apps/local`
 * accepts, so splunkd receives the archive bytes directly.
 *
 * The REST reference documents only `name=<path-or-URL>` + `filename=true`,
 * where splunkd resolves the package ITSELF — which a remote caller cannot use,
 * because it has nowhere on the Splunk host to put the file. Uploading the bytes
 * is the form every remote installer uses, and it is the only way to ship a
 * `bin/` script: the REST configs API can write .conf stanzas but no other file.
 */
export function buildInstallUpload(
  pkg: BuiltPackage,
  options: { update: boolean },
): InstallUpload {
  const boundary = `----veltrix${createHash('sha256').update(pkg.sha256).digest('hex').slice(0, 24)}`
  const parts: Buffer[] = []

  const field = (name: string, value: string) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    )
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="name"; filename="${pkg.fileName}"\r\n` +
        'Content-Type: application/gzip\r\n\r\n',
      'utf8',
    ),
  )
  parts.push(pkg.bytes)
  parts.push(Buffer.from('\r\n', 'utf8'))

  field('filename', '1')
  field('update', options.update ? '1' : '0')

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

// --- Static validation -------------------------------------------------------

export interface SpecIssue {
  field: string
  message: string
  code: string
}

export interface SpecIssues {
  errors: SpecIssue[]
  warnings: SpecIssue[]
}

export interface ValidateSpecOptions {
  /**
   * Apply Splunk Cloud vetting rules as ERRORS (denied confs, banned input
   * stanzas, real-time searches, sc_admin write access, ...). On Enterprise the
   * same findings are mostly warnings, because splunkd will happily accept them.
   */
  cloud: boolean
  /** Prefix for every issue's `field`, so a multi-item canvas points at the right item. */
  prefix: string
}

/**
 * Validate one app spec against everything checkable without touching Splunk.
 * The package is actually BUILT here, so a generator bug (a path that will not
 * fit a tar header, an oversized package) surfaces at validation time rather
 * than mid-deploy.
 */
export function validateAppSpec(spec: AppPackageSpec, opts: ValidateSpecOptions): SpecIssues {
  const errors: SpecIssue[] = []
  const warnings: SpecIssue[] = []
  const { prefix, cloud } = opts
  const err = (field: string, message: string, code: string) =>
    errors.push({ field: `${prefix}.${field}`, message, code })
  const warn = (field: string, message: string, code: string) =>
    warnings.push({ field: `${prefix}.${field}`, message, code })

  validateIdentity(spec, err, warn)
  validatePermissions(spec, cloud, err, warn)
  validateConfInventory(spec, cloud, err, warn)

  for (const conf of spec.confFiles) {
    validateConfFile(conf, spec, cloud, err, warn)
  }

  validateBinScripts(spec, err, warn)

  // Build the archive — this is the only way to know the real packaged size and
  // to prove every path fits a ustar header.
  if (spec.appId && spec.version && errors.length === 0) {
    try {
      const built = buildAppPackage(spec)
      if (built.sizeBytes > MAX_PACKAGE_BYTES) {
        err(
          'package',
          `Package is ${(built.sizeBytes / 1024 / 1024).toFixed(1)} MB — Splunk rejects packages over 128 MB`,
          'package_too_large',
        )
      }
      for (const issue of checkReloadTriggers(built.appConf, spec.confFiles.map((c) => c.name))) {
        errors.push({ field: `${prefix}.${issue.field}`, message: issue.message, code: issue.code })
      }
    } catch (error) {
      err(
        'package',
        `Package could not be built: ${error instanceof Error ? error.message : 'unknown error'}`,
        'package_build_failed',
      )
    }
  }

  return { errors, warnings }
}

type Report = (field: string, message: string, code: string) => void

function validateIdentity(spec: AppPackageSpec, err: Report, warn: Report): void {
  // --- App id -----------------------------------------------------------
  const { appId } = spec
  if (!appId) {
    err('appId', 'App ID is required — it is the folder name inside the package', 'required')
  } else {
    if (!APP_ID_CHARSET.test(appId)) {
      err(
        'appId',
        'App ID may contain only letters, numbers, ".", "_" and "-"',
        'invalid_format',
      )
    }
    if (/^[0-9]/.test(appId)) {
      err('appId', 'App ID must not start with a digit', 'starts_with_digit')
    }
    if (appId.startsWith('.')) {
      err('appId', 'App ID must not start with "." — dotfiles are stripped from packages', 'dotfile')
    }
    if (appId.endsWith('.')) {
      err('appId', 'App ID must not end with "."', 'trailing_dot')
    }
    if (appId.length > MAX_APP_ID_LENGTH) {
      err('appId', `App ID must be ${MAX_APP_ID_LENGTH} characters or fewer`, 'max_length')
    }
    const base = appId.split('.')[0].toLowerCase()
    if (WINDOWS_RESERVED_NAMES.has(appId.toLowerCase()) || WINDOWS_RESERVED_NAMES.has(base)) {
      err(
        'appId',
        `"${appId}" is a Windows reserved device name — the app folder cannot be created on a Windows Splunk host`,
        'reserved_name',
      )
    }
  }

  // --- Version ([id] version MUST equal [launcher] version — we emit one value) ---
  if (!spec.version) {
    err('version', 'Version is required', 'required')
  } else if (!SEMVER_3_PART.test(spec.version)) {
    err(
      'version',
      'Version must be 3-part semver (e.g. 1.0.0) — Splunk uses it for both [id] version and [launcher] version',
      'invalid_version',
    )
  }

  // --- Label ([ui] label is required even for an invisible add-on) -------
  if (!spec.label) {
    err('label', 'Label is required — Splunk requires [ui] label even for an invisible add-on', 'required')
  } else if (spec.label.length < MIN_LABEL_LENGTH) {
    err('label', `Label must be at least ${MIN_LABEL_LENGTH} characters`, 'min_length')
  } else if (spec.label.length > MAX_LABEL_LENGTH) {
    err('label', `Label must be ${MAX_LABEL_LENGTH} characters or fewer`, 'max_length')
  }

  // --- Author / description ---------------------------------------------
  if (!spec.author) {
    err('author', 'Author is required', 'required')
  }
  if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
    err(
      'description',
      `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.description.length})`,
      'max_length',
    )
  }
  if (/\r?\n/.test(spec.description)) {
    warn(
      'description',
      'Description spans multiple lines — a conf value is single-line, so the newlines are collapsed to spaces in app.conf',
      'multiline_description',
    )
  }

  // --- Build -------------------------------------------------------------
  if (!Number.isInteger(spec.build) || spec.build < 1) {
    err('build', 'Build must be a positive integer', 'invalid_build')
  }
}

function validatePermissions(spec: AppPackageSpec, cloud: boolean, err: Report, warn: Report): void {
  if (!spec.writeRoles.includes('sc_admin')) {
    const message =
      'metadata/default.meta write access must include sc_admin — it is the administrator role on Splunk Cloud'
    if (cloud) err('writeRoles', message, 'missing_sc_admin')
    else warn('writeRoles', `${message} (harmless on Enterprise, required if this app ever ships to Cloud)`, 'missing_sc_admin')
  }
  if (!spec.writeRoles.includes('admin')) {
    warn('writeRoles', 'metadata/default.meta write access does not include admin', 'missing_admin')
  }
  if (spec.globalExport === 'system') {
    warn(
      'globalExport',
      'Exporting the whole app to system scope makes every object global — prefer export = none plus a per-object-type export',
      'broad_export',
    )
  }

  // Exporting an object type that the app never defines is a no-op.
  const confBases = new Set(spec.confFiles.map((c) => confBaseName(c.name).toLowerCase()))
  for (const object of spec.exportedObjects) {
    // lookups are declared in transforms.conf, so transforms covers them.
    const backing = object === 'lookups' ? 'transforms' : object
    if (!confBases.has(backing)) {
      warn(
        'exportedObjects',
        `"${object}" is exported to system scope but the app ships no ${backing}.conf — the export has no effect`,
        'export_without_objects',
      )
    }
  }
}

function validateConfInventory(spec: AppPackageSpec, cloud: boolean, err: Report, warn: Report): void {
  if (spec.strayConfContent) {
    err(
      'additionalConfs',
      'Content appears before the first ">>> file: <name>.conf" marker — every additional conf must start with a marker line',
      'missing_file_marker',
    )
  }
  if (spec.strayScriptContent) {
    err(
      'binScripts',
      'Content appears before the first ">>> file: <name>" marker — every bin script must start with a marker line',
      'missing_file_marker',
    )
  }

  // A package that is ONLY app.conf is rejected by Splunk.
  if (spec.confFiles.length === 0) {
    err(
      'confFiles',
      'An app must ship at least one real conf beyond the generated app.conf — add inputs/props/transforms content',
      'no_conf_files',
    )
  }

  const seen = new Set<string>()
  for (const conf of spec.confFiles) {
    const lower = conf.name.toLowerCase()

    if (RESERVED_CONFS.has(lower)) {
      err(
        'additionalConfs',
        `"${conf.name}" is generated from the Identity and Packaging fields and must not be supplied by hand`,
        'reserved_conf',
      )
      continue
    }
    if (!CONF_FILE_NAME.test(conf.name)) {
      err(
        'additionalConfs',
        `"${conf.name}" is not a valid conf file name — use letters, numbers, "_" or "-" plus a .conf suffix, with no spaces`,
        'invalid_conf_name',
      )
      continue
    }
    if (seen.has(lower)) {
      err('additionalConfs', `Duplicate conf file: "${conf.name}"`, 'duplicate_conf_file')
    }
    seen.add(lower)

    // indexes.conf: an add-on must REFERENCE an index, never create one.
    if (lower === 'indexes.conf') {
      err(
        'additionalConfs',
        cloud
          ? 'indexes.conf is banned on Splunk Cloud — reference an existing index and create it with the Index Configuration type'
          : 'An add-on must reference an existing index, never create one — remove indexes.conf and use the Index Configuration type',
        'indexes_conf_forbidden',
      )
    }

    if (cloud && CLOUD_DENIED_CONFS.has(lower)) {
      err(
        'additionalConfs',
        `${conf.name} is on the Splunk Cloud deny list — AppInspect fails any app that ships it`,
        'cloud_denied_conf',
      )
    }
  }
}

function validateConfFile(
  conf: ConfFile,
  spec: AppPackageSpec,
  cloud: boolean,
  err: Report,
  warn: Report,
): void {
  const field = confFieldFor(conf.name)
  const parsed = parseConf(conf.content)
  const lower = conf.name.toLowerCase()
  const standard = !isCustomConf(conf.name)

  if (parsed.preamble.length > 0) {
    err(
      field,
      `${conf.name}: "${parsed.preamble[0].key}" (line ${parsed.preamble[0].line}) appears before any [stanza]`,
      'key_outside_stanza',
    )
  }
  if (parsed.stanzas.length === 0 && parsed.preamble.length === 0) {
    warn(field, `${conf.name} has no stanzas — it will ship as an empty file`, 'empty_conf')
  }

  const seenStanzas = new Set<string>()
  for (const stanza of parsed.stanzas) {
    // A [default] stanza in a standard conf silently rewrites Splunk's own defaults.
    if (standard && stanza.name.toLowerCase() === 'default') {
      err(
        field,
        `${conf.name} line ${stanza.line}: a [default] stanza in a standard conf overrides Splunk's own defaults for every app`,
        'default_stanza',
      )
    }

    if (seenStanzas.has(stanza.name)) {
      err(field, `${conf.name} line ${stanza.line}: duplicate stanza [${stanza.name}]`, 'duplicate_stanza')
    }
    seenStanzas.add(stanza.name)

    const seenKeys = new Set<string>()
    for (const entry of stanza.keys) {
      if (seenKeys.has(entry.key)) {
        err(
          field,
          `${conf.name} line ${entry.line}: duplicate key "${entry.key}" in [${stanza.name}]`,
          'duplicate_key',
        )
      }
      seenKeys.add(entry.key)

      if (LEADING_ABSOLUTE_PATH.test(entry.value)) {
        err(
          field,
          `${conf.name} line ${entry.line}: "${entry.key}" is an absolute path — apps must use $SPLUNK_HOME/$SPLUNK_DB relative paths`,
          'absolute_path',
        )
      } else if (EMBEDDED_ABSOLUTE_PATH.test(entry.value)) {
        warn(
          field,
          `${conf.name} line ${entry.line}: "${entry.key}" contains what looks like an absolute path — verify it is a regex, not a hardcoded location`,
          'possible_absolute_path',
        )
      }
    }

    validateStanzaForTarget(conf, stanza, cloud, field, err, warn)
  }

  if (cloud) {
    validateCloudConditionalConf(conf, parsed, lower, field, err)
  }
}

/** Stanza-level rules that differ between Enterprise and Cloud. */
function validateStanzaForTarget(
  conf: ConfFile,
  stanza: ConfStanza,
  cloud: boolean,
  field: string,
  err: Report,
  warn: Report,
): void {
  const lower = conf.name.toLowerCase()

  if (lower === 'inputs.conf') {
    // A bare [http] stanza reconfigures the GLOBAL HEC input rather than
    // declaring a token — always wrong in an app.
    if (stanza.name.toLowerCase() === 'http') {
      const message = `${conf.name} line ${stanza.line}: a bare [http] stanza reconfigures the global HEC input — declare a token as [http://<name>]`
      if (cloud) err(field, message, 'bare_http_stanza')
      else warn(field, message, 'bare_http_stanza')
    }

    for (const banned of CLOUD_BANNED_INPUT_STANZAS) {
      if (banned.pattern.test(stanza.name)) {
        if (cloud) {
          err(
            field,
            `${conf.name} line ${stanza.line}: [${stanza.name}] — ${banned.what} are not permitted on Splunk Cloud; send data via HEC or a forwarder`,
            'cloud_banned_input',
          )
        }
        break
      }
    }
  }

  if (lower === 'savedsearches.conf') {
    for (const entry of stanza.keys) {
      // Real-time searches pin a search process forever.
      if (
        (entry.key === 'dispatch.earliest_time' || entry.key === 'dispatch.latest_time') &&
        /^rt/i.test(entry.value)
      ) {
        const message = `${conf.name} line ${entry.line}: [${stanza.name}] uses a real-time search window ("${entry.value}")`
        if (cloud) err(field, `${message} — real-time searches are not permitted on Splunk Cloud`, 'realtime_search')
        else warn(field, `${message} — real-time searches consume a search slot permanently`, 'realtime_search')
      }

      if (entry.key === 'cron_schedule') {
        const issue = tooFrequentCron(entry.value)
        if (issue) {
          const message = `${conf.name} line ${entry.line}: [${stanza.name}] cron "${entry.value}" runs ${issue}`
          if (cloud) err(field, `${message} — Splunk Cloud forbids schedules more frequent than every 5 minutes`, 'cron_too_frequent')
          else warn(field, `${message} — schedules under 5 minutes starve the scheduler`, 'cron_too_frequent')
        }
      }
    }
  }

  if (lower === 'savedsearches.conf' || lower === 'macros.conf') {
    for (const entry of stanza.keys) {
      if ((entry.key === 'search' || entry.key === 'definition') && /\bindex\s*=\s*\*/i.test(entry.value)) {
        const message = `${conf.name} line ${entry.line}: [${stanza.name}] searches "index=*", which scans every index on the deployment`
        if (cloud) err(field, `${message} — Splunk Cloud rejects it`, 'index_wildcard')
        else warn(field, message, 'index_wildcard')
      }
    }
  }
}

/** web.conf and server.conf are allowed on Cloud only for a narrow set of stanzas. */
function validateCloudConditionalConf(
  conf: ConfFile,
  parsed: ParsedConf,
  lower: string,
  field: string,
  err: Report,
): void {
  if (lower === 'web.conf') {
    for (const stanza of parsed.stanzas) {
      if (!CLOUD_WEB_CONF_ALLOWED.some((allowed) => allowed.test(stanza.name))) {
        err(
          field,
          `web.conf line ${stanza.line}: [${stanza.name}] — Splunk Cloud permits web.conf only for [endpoint:*] and [expose:*] stanzas`,
          'cloud_denied_conf',
        )
      }
    }
  }

  if (lower === 'server.conf') {
    for (const stanza of parsed.stanzas) {
      const allowed = CLOUD_SERVER_CONF_ALLOWED.find((rule) => rule.stanza.test(stanza.name))
      if (!allowed) {
        err(
          field,
          `server.conf line ${stanza.line}: [${stanza.name}] — Splunk Cloud permits server.conf only for [shclustering] conf_replication_include.* and [diag] EXCLUDE-* keys`,
          'cloud_denied_conf',
        )
        continue
      }
      for (const entry of stanza.keys) {
        if (!allowed.keys.test(entry.key)) {
          err(
            field,
            `server.conf line ${entry.line}: "${entry.key}" is not permitted in [${stanza.name}] on Splunk Cloud`,
            'cloud_denied_conf',
          )
        }
      }
    }
  }
}

function validateBinScripts(spec: AppPackageSpec, err: Report, warn: Report): void {
  const seen = new Set<string>()
  for (const script of spec.binScripts) {
    for (const excluded of EXCLUDED_PACKAGE_PATTERNS) {
      if (excluded.pattern.test(script.name)) {
        err(
          'binScripts',
          `"${script.name}" cannot be packaged — ${excluded.why} is excluded from a Splunk app`,
          'excluded_file',
        )
      }
    }
    if (script.name.length > 0 && !SCRIPT_FILE_NAME.test(script.name)) {
      err(
        'binScripts',
        `"${script.name}" is not a valid bin script name — letters, numbers, ".", "_" and "-" only`,
        'invalid_script_name',
      )
    }
    if (seen.has(script.name.toLowerCase())) {
      err('binScripts', `Duplicate bin script: "${script.name}"`, 'duplicate_script')
    }
    seen.add(script.name.toLowerCase())

    if (script.content.trim().length === 0) {
      warn('binScripts', `"${script.name}" is empty`, 'empty_script')
    }
  }
}

/**
 * Assert the invariant the app.conf generator is responsible for: every CUSTOM
 * conf has a `[triggers] reload.<name> = simple` entry, and no standard conf
 * has one. Exported so it can be exercised directly against a hand-written
 * app.conf.
 */
export function checkReloadTriggers(appConf: string, confFileNames: string[]): SpecIssue[] {
  const issues: SpecIssue[] = []
  const triggers = parseConf(appConf).stanzas.find((s) => s.name === 'triggers')
  const declared = new Set(
    (triggers?.keys ?? [])
      .filter((entry) => entry.key.startsWith('reload.'))
      .map((entry) => entry.key.slice('reload.'.length)),
  )

  for (const fileName of confFileNames) {
    const base = confBaseName(fileName)
    if (isCustomConf(fileName)) {
      if (!declared.has(base)) {
        issues.push({
          field: 'additionalConfs',
          message: `Custom conf "${fileName}" has no [triggers] reload.${base} entry — installing the app would force a full Splunk restart every time`,
          code: 'missing_reload_trigger',
        })
      }
    } else if (declared.has(base)) {
      issues.push({
        field: 'additionalConfs',
        message: `"${fileName}" is a standard Splunk conf — it must not get a [triggers] reload.${base} entry`,
        code: 'standard_conf_trigger',
      })
    }
  }

  return issues
}

/** Describe a cron schedule that fires more often than every 5 minutes, else null. */
function tooFrequentCron(expression: string): string | null {
  const minute = expression.trim().split(/\s+/)[0]
  if (!minute) return null

  if (minute === '*') return 'every minute'

  const step = /^\*\/(\d+)$/.exec(minute)
  if (step) {
    const interval = Number(step[1])
    if (interval < 5) return `every ${interval} minute(s)`
    return null
  }

  // An explicit list: check the smallest gap between consecutive minutes.
  if (minute.includes(',')) {
    const minutes = minute
      .split(',')
      .map((m) => Number(m))
      .filter((m) => Number.isInteger(m))
      .sort((a, b) => a - b)
    for (let i = 1; i < minutes.length; i++) {
      if (minutes[i] - minutes[i - 1] < 5) return `twice within ${minutes[i] - minutes[i - 1]} minute(s)`
    }
  }

  return null
}

/** Point an issue at the authored file inside the `appFiles` field. */
function confFieldFor(fileName: string): string {
  return `appFiles.default/${fileName}`
}
