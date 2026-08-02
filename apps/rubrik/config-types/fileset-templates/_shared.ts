// Shared helpers for the Rubrik Fileset Templates config type (deploy + rollback + drift).
//
// A fileset template is Rubrik's reusable definition of WHAT to back up on a host:
// a name, the host OS family, and the include / exclude / exception path lists
// (full paths + wildcards). It is applied to hosts to produce filesets. Managed
// over the Rubrik CDM v1 REST API:
//   list:   GET    /api/v1/fileset_template
//   create: POST   /api/v1/fileset_template
//   read:   GET    /api/v1/fileset_template/{id}
//   update: PATCH  /api/v1/fileset_template/{id}
//   delete: DELETE /api/v1/fileset_template/{id}?preserve_snapshots=<bool>
//
// Endpoints verified against the Rubrik CDM v5.0.0-p1 "v1 REST API" postman
// collection (rubrikinc/rubrik-postman). Body field names follow the Rubrik
// PowerShell SDK's New-RubrikFilesetTemplate (rubrikinc/rubrik-sdk-for-powershell).
//
// FLAG (verify against a live Rubrik CDM cluster): the exact create/patch body
// shape, and whether CDM 4.2+ expects operatingSystemType "UnixLike" in place of
// "Linux" (the v1 enum was historically Linux/Windows; 4.2+ renamed Linux to
// UnixLike). This config type manages HOST filesets (operatingSystemType); NAS
// filesets (shareType NFS/SMB) are intentionally out of scope for this foundation.

/** Host OS families a host fileset template targets (v1 FilesetTemplateCreateDefinition enum). */
export const OS_TYPES = ['Linux', 'Windows'] as const
export type OsType = (typeof OS_TYPES)[number]

/** How a failing pre/post backup script is handled. */
export const ERROR_HANDLING = ['abort', 'continue'] as const
export type ErrorHandling = (typeof ERROR_HANDLING)[number]

/** One fileset template as returned by the Rubrik CDM v1 API. */
export interface RubrikFilesetTemplate {
  id?: string
  name?: string
  operatingSystemType?: string
  includes?: string[]
  excludes?: string[]
  exceptions?: string[]
  useWindowsVss?: boolean
  allowBackupNetworkMounts?: boolean
  allowBackupHiddenFoldersInNetworkMounts?: boolean
  preBackupScript?: string
  postBackupScript?: string
  backupScriptTimeout?: number
  backupScriptErrorHandling?: string
  [key: string]: unknown
}

/** Trim + normalize a value for stable identity matching. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * Coerce a canvas field to a clean string[]. Accepts a native array (the `tags`
 * field type) OR a comma/newline-separated string (a `textarea`), preserving
 * order while dropping blanks and duplicates.
 */
export function toStringArray(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => String(v ?? ''))
    : String(value ?? '').split(/[\r\n,]+/)
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const s = item.trim()
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/** Coerce a canvas OS-type field to a known enum value (defaults to Linux). */
export function normalizeOsType(value: unknown): OsType {
  const s = normalizeName(value)
  return (OS_TYPES as readonly string[]).includes(s) ? (s as OsType) : 'Linux'
}

/** Coerce a canvas field (checkbox / string) to a boolean. */
export function toBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1'
}

/** Coerce a canvas field to a positive integer, or undefined when blank/invalid. */
export function toIntOrUndefined(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/**
 * Build the v1 fileset-template request body from the flat canvas fields.
 * `includes` is the only required path list (Rubrik rejects a template with no
 * includes). useWindowsVss is emitted only for Windows templates; script and
 * timeout fields are emitted only when set so a minimal template stays minimal.
 */
export function buildFilesetTemplateBody(fields: Record<string, unknown>): Record<string, unknown> {
  const os = normalizeOsType(fields.operatingSystemType)
  const body: Record<string, unknown> = {
    name: normalizeName(fields.name),
    operatingSystemType: os,
    includes: toStringArray(fields.includes),
    excludes: toStringArray(fields.excludes),
    exceptions: toStringArray(fields.exceptions),
    allowBackupNetworkMounts: toBool(fields.allowBackupNetworkMounts),
  }
  if (os === 'Windows') body.useWindowsVss = toBool(fields.useWindowsVss)
  if (toBool(fields.allowBackupHiddenFoldersInNetworkMounts)) {
    body.allowBackupHiddenFoldersInNetworkMounts = true
  }
  const pre = normalizeName(fields.preBackupScript)
  const post = normalizeName(fields.postBackupScript)
  if (pre) body.preBackupScript = pre
  if (post) body.postBackupScript = post
  const timeout = toIntOrUndefined(fields.backupScriptTimeout)
  if (timeout !== undefined) body.backupScriptTimeout = timeout
  const eh = normalizeName(fields.backupScriptErrorHandling)
  if ((ERROR_HANDLING as readonly string[]).includes(eh)) body.backupScriptErrorHandling = eh
  return body
}

/** Unwrap the v1 list envelope ({ data, total, hasMore }) into a flat array. */
export function filesetTemplatesFromList(resp: unknown): RubrikFilesetTemplate[] {
  if (Array.isArray(resp)) return resp as RubrikFilesetTemplate[]
  if (resp && typeof resp === 'object' && Array.isArray((resp as { data?: unknown }).data)) {
    return (resp as { data: RubrikFilesetTemplate[] }).data
  }
  return []
}

/** Find a live fileset template by its (case-sensitive, trimmed) name; null when absent. */
export function findTemplateByName(
  list: RubrikFilesetTemplate[],
  name: string,
): RubrikFilesetTemplate | null {
  const n = normalizeName(name)
  if (!n) return null
  return list.find((t) => normalizeName(t.name) === n) ?? null
}

/**
 * Flatten a template into a comparable string map for drift detection. Path lists
 * are sorted so ordering never registers as drift; only membership does.
 */
export function summarizeTemplate(t: RubrikFilesetTemplate | undefined): Record<string, string> {
  if (!t) return {}
  const join = (v: unknown) => [...toStringArray(v)].sort().join('|')
  return {
    os: normalizeOsType(t.operatingSystemType),
    includes: join(t.includes),
    excludes: join(t.excludes),
    exceptions: join(t.exceptions),
    networkMounts: String(toBool(t.allowBackupNetworkMounts)),
  }
}
