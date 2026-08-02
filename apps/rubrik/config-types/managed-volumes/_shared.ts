// Shared helpers for the Rubrik Managed Volumes config type (deploy + rollback + drift).
//
// A managed volume (MV) is a Rubrik-hosted, SLA-protected storage target that
// applications (databases, backup tools) write into over NFS/SMB channels. This
// config type declares the MVs a cluster should host — name, channel count, size,
// optional subnet, application tag and export host patterns — as code. Managed
// over the Rubrik CDM INTERNAL REST API:
//   list:   GET    /api/internal/managed_volume
//   create: POST   /api/internal/managed_volume
//   read:   GET    /api/internal/managed_volume/{id}
//   update: PATCH  /api/internal/managed_volume/{id}
//   delete: DELETE /api/internal/managed_volume/{id}?preserve_snapshots=<bool>
//
// Endpoints verified against the Rubrik CDM v5.0.0-p1 "INTERNAL REST API" postman
// collection (rubrikinc/rubrik-postman). Body field names follow the Rubrik
// PowerShell SDK's New-RubrikManagedVolume (rubrikinc/rubrik-sdk-for-powershell):
// name, numChannels, volumeSize (bytes), subnet, applicationTag, exportConfig.
//
// FLAG (verify against a live Rubrik CDM cluster): the exact create/patch body
// shape — especially the exportConfig object (hostPatterns vs channelHostMountPaths)
// — and that /api/internal endpoints, being internal, may change across CDM
// versions. numChannels and volumeSize are set at creation and are effectively
// IMMUTABLE afterwards, so update PATCHes only the mutable subset (name, exportConfig).

/** 1 GiB in bytes — canvas takes size in GiB, the API takes bytes. */
export const BYTES_PER_GIB = 1024 * 1024 * 1024

/** Application tags a managed volume can be tagged with (New-RubrikManagedVolume enum). */
export const APPLICATION_TAGS = [
  'Oracle',
  'OracleIncremental',
  'MsSql',
  'SapHana',
  'MySql',
  'PostgreSql',
  'RecoverX',
] as const
export type ApplicationTag = (typeof APPLICATION_TAGS)[number]

/** One managed volume as returned by the Rubrik CDM internal API. */
export interface RubrikManagedVolume {
  id?: string
  name?: string
  numChannels?: number
  volumeSize?: number
  subnet?: string
  applicationTag?: string
  exportConfig?: { hostPatterns?: string[]; [key: string]: unknown }
  [key: string]: unknown
}

/** Trim + normalize a value for stable identity matching. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a canvas field to a positive integer, or 0 when blank/invalid. */
export function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * Coerce a canvas field to a clean string[]. Accepts a native array (`tags`) OR a
 * comma/newline-separated string, preserving order while dropping blanks + dupes.
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

/** Coerce a canvas field to a known application tag, or undefined (tag is optional). */
export function normalizeApplicationTag(value: unknown): ApplicationTag | undefined {
  const s = normalizeName(value)
  return (APPLICATION_TAGS as readonly string[]).includes(s) ? (s as ApplicationTag) : undefined
}

/** Convert a canvas GiB size to bytes for the API (0 when blank/invalid). */
export function gibToBytes(value: unknown): number {
  return toInt(value) * BYTES_PER_GIB
}

/** Build the exportConfig object from host patterns, or undefined when none set. */
function buildExportConfig(fields: Record<string, unknown>): { hostPatterns: string[] } | undefined {
  const hostPatterns = toStringArray(fields.hostPatterns)
  return hostPatterns.length ? { hostPatterns } : undefined
}

/**
 * Build the internal managed-volume CREATE body from the flat canvas fields.
 * numChannels is required by the API; volumeSize, subnet, applicationTag and
 * exportConfig are emitted only when set.
 */
export function buildManagedVolumeBody(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: normalizeName(fields.name),
    numChannels: toInt(fields.numChannels),
  }
  const size = gibToBytes(fields.volumeSizeGb)
  if (size > 0) body.volumeSize = size
  const subnet = normalizeName(fields.subnet)
  if (subnet) body.subnet = subnet
  const tag = normalizeApplicationTag(fields.applicationTag)
  if (tag) body.applicationTag = tag
  const exportConfig = buildExportConfig(fields)
  if (exportConfig) body.exportConfig = exportConfig
  return body
}

/**
 * Build the managed-volume PATCH body — only the mutable subset. numChannels and
 * volumeSize are fixed at creation, so an update carries just the name and the
 * export configuration. FLAG: confirm the patchable fields against a live cluster.
 */
export function buildManagedVolumePatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { name: normalizeName(fields.name) }
  const exportConfig = buildExportConfig(fields)
  if (exportConfig) body.exportConfig = exportConfig
  return body
}

/** Unwrap the internal list envelope ({ data, total, hasMore }) into a flat array. */
export function managedVolumesFromList(resp: unknown): RubrikManagedVolume[] {
  if (Array.isArray(resp)) return resp as RubrikManagedVolume[]
  if (resp && typeof resp === 'object' && Array.isArray((resp as { data?: unknown }).data)) {
    return (resp as { data: RubrikManagedVolume[] }).data
  }
  return []
}

/** Find a live managed volume by its (case-sensitive, trimmed) name; null when absent. */
export function findManagedVolumeByName(
  list: RubrikManagedVolume[],
  name: string,
): RubrikManagedVolume | null {
  const n = normalizeName(name)
  if (!n) return null
  return list.find((mv) => normalizeName(mv.name) === n) ?? null
}

/** Re-derive the canvas-shaped fields from a prior live MV so the builders re-emit it. */
export function managedVolumeToFields(mv: RubrikManagedVolume): Record<string, unknown> {
  return {
    name: mv.name,
    numChannels: mv.numChannels ?? 0,
    volumeSizeGb: mv.volumeSize ? Math.round(mv.volumeSize / BYTES_PER_GIB) : 0,
    subnet: mv.subnet ?? '',
    applicationTag: mv.applicationTag ?? '',
    hostPatterns: mv.exportConfig?.hostPatterns ?? [],
  }
}

/**
 * Flatten an MV into a comparable string map for drift detection. Host patterns
 * are sorted so ordering never registers as drift; only membership does.
 */
export function summarizeManagedVolume(mv: RubrikManagedVolume | undefined): Record<string, string> {
  if (!mv) return {}
  return {
    channels: String(mv.numChannels ?? ''),
    sizeBytes: String(mv.volumeSize ?? ''),
    applicationTag: normalizeName(mv.applicationTag),
    subnet: normalizeName(mv.subnet),
    hostPatterns: [...toStringArray(mv.exportConfig?.hostPatterns)].sort().join('|'),
  }
}
