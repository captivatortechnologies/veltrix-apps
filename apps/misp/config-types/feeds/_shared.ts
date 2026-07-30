// Shared helpers for the MISP Threat Feeds config type (deploy + rollback + drift).
//
// MISP feed shapes follow the 2.4 REST API (/feeds, /feeds/add, /feeds/edit/{id});
// verify against a live MISP 2.4 instance.

/** Valid MISP feed source formats. */
export const SOURCE_FORMATS = new Set(['misp', 'csv', 'freetext'])

/** One MISP feed as returned inside a `{ Feed: {...} }` envelope by /feeds. */
export interface MispFeed {
  id?: number | string
  name?: string
  provider?: string
  url?: string
  source_format?: string
  enabled?: boolean | number | string
  [key: string]: unknown
}

/**
 * `enabled` may arrive from the canvas as a boolean or an 'enabled'/'disabled'
 * string, or from MISP as a boolean / 1|0 / '1'|'0' — normalize to a boolean.
 */
export function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'disabled' || s === 'false' || s === '0') return false
  if (s === '') return true
  return true
}

/** Strip a trailing slash so two URLs that differ only by it still match. */
function normalizeUrl(url: unknown): string {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

/** Unwrap MISP's `[{ Feed: {...} }]` list into a flat array of feeds. */
export function feedsFromList(list: unknown): MispFeed[] {
  if (!Array.isArray(list)) return []
  return list.map((row) =>
    row && typeof row === 'object' && 'Feed' in (row as Record<string, unknown>)
      ? ((row as { Feed: MispFeed }).Feed)
      : (row as MispFeed),
  )
}

/** Find a live feed by URL first (the stable identity), then by name. */
export function findFeed(feeds: MispFeed[], url: string, name: string): MispFeed | null {
  const u = normalizeUrl(url)
  if (u) {
    const byUrl = feeds.find((f) => normalizeUrl(f.url) === u)
    if (byUrl) return byUrl
  }
  const n = name.trim()
  if (n) {
    const byName = feeds.find((f) => String(f.name ?? '').trim() === n)
    if (byName) return byName
  }
  return null
}

/** Build the MISP feed body from canvas fields (wrapped in the `{ Feed: {...} }` envelope by callers). */
export function buildFeedFields(fields: Record<string, unknown>): MispFeed {
  return {
    name: String(fields.name ?? '').trim(),
    provider: String(fields.provider ?? '').trim(),
    url: String(fields.url ?? '').trim(),
    source_format: String(fields.sourceFormat ?? '').trim(),
    enabled: normalizeEnabled(fields.enabled),
  }
}
