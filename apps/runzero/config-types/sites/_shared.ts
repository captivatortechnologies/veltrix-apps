// Shared helpers for the runZero Sites config type (deploy + rollback + drift + validate).
//
// A runZero Site is the scan-scope container assets are grouped under. The console
// API models it as:
//   Site (response):    id (uuid), name, description, scope, excludes, permanent,
//                       created_at, updated_at
//   SiteOptions (body): name (required), description, scope, excludes
// (verified against runZeroInc/runzero-api-go docs — Site.md / SiteOptions.md).
//
// The canvas exposes a single `subnets` textarea for the default scan scope; it
// maps to the API `scope` string (a newline/comma-separated list of CIDRs/hosts).

/** One runZero Site as returned by GET /org/sites (a bare array of these). */
export interface RunzeroSite {
  id?: string
  name?: string
  description?: string
  scope?: string
  excludes?: string
  permanent?: boolean
  [key: string]: unknown
}

/** The SiteOptions request body for PUT (create) / PATCH (update). */
export interface RunzeroSiteOptions {
  name: string
  description: string
  scope: string
}

/** One entry in deploy's rollbackData.previous — what deploy did to a single site. */
export interface SiteRollbackEntry {
  name: string
  siteId: string | null
  existed: boolean
  prior: RunzeroSite | null
}

/**
 * Split a scope/subnets blob into a normalized list of entries. runZero accepts
 * CIDRs/hosts separated by newlines, commas or whitespace; this tolerates all and
 * drops blanks. Used for both sending and set-based drift comparison.
 */
export function parseScopeEntries(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Canonical scope string sent to the API — one entry per line (runZero's own form). */
export function normalizeScope(value: unknown): string {
  return parseScopeEntries(value).join('\n')
}

/** True when two scope blobs describe the same SET of entries (order-insensitive). */
export function scopeEquals(a: unknown, b: unknown): boolean {
  const sa = new Set(parseScopeEntries(a))
  const sb = new Set(parseScopeEntries(b))
  if (sa.size !== sb.size) return false
  for (const entry of sa) if (!sb.has(entry)) return false
  return true
}

/** Coerce a runZero list response into rows (a bare array, or a `{ data: [...] }` wrapper). */
export function sitesFromList(list: unknown): RunzeroSite[] {
  if (Array.isArray(list)) return list as RunzeroSite[]
  if (list && typeof list === 'object' && Array.isArray((list as { data?: unknown }).data)) {
    return (list as { data: RunzeroSite[] }).data
  }
  return []
}

/** Find a live site by name (case-insensitive — the stable identity for upsert/drift). */
export function findSite(sites: RunzeroSite[], name: string): RunzeroSite | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return sites.find((s) => String(s.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Build the SiteOptions body from canvas fields (`subnets` textarea → API `scope`). */
export function buildSiteOptions(fields: Record<string, unknown>): RunzeroSiteOptions {
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    scope: normalizeScope(fields.subnets),
  }
}
