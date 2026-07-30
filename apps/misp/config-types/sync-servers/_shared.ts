// Shared helpers for the MISP Sync Servers config type (deploy + rollback + drift).
//
// MISP sync-server shapes follow the 2.4 REST API (/servers, /servers/add,
// /servers/edit/{id}); verify against a live MISP 2.4 instance.

/** Valid yes/no select values from the canvas. */
export const YES_NO = new Set(['yes', 'no'])

/** One MISP sync server as returned inside a `{ Server: {...} }` envelope by /servers. */
export interface MispServer {
  id?: number | string
  name?: string
  url?: string
  authkey?: string
  pull?: boolean | number | string
  push?: boolean | number | string
  [key: string]: unknown
}

/** Normalize a yes/no select (or a boolean / 1|0) to a boolean. */
export function normalizeYesNo(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1'
}

/** Strip a trailing slash so two URLs that differ only by it still match. */
export function normalizeUrl(url: unknown): string {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

/** Coerce a MISP list response into rows (a bare array or a `{ response: [...] }` wrapper). */
function asRows(list: unknown): unknown[] {
  if (Array.isArray(list)) return list
  if (list && typeof list === 'object' && Array.isArray((list as { response?: unknown }).response)) {
    return (list as { response: unknown[] }).response
  }
  return []
}

/** Unwrap MISP's `[{ Server: {...} }]` list into a flat array of sync servers. */
export function serversFromList(list: unknown): MispServer[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'Server' in (row as Record<string, unknown>)
      ? ((row as { Server: MispServer }).Server)
      : (row as MispServer),
  )
}

/** Find a live sync server by URL first (the stable identity), then by name. */
export function findServer(servers: MispServer[], url: string, name: string): MispServer | null {
  const u = normalizeUrl(url)
  if (u) {
    const byUrl = servers.find((s) => normalizeUrl(s.url) === u)
    if (byUrl) return byUrl
  }
  const n = name.trim()
  if (n) {
    const byName = servers.find((s) => String(s.name ?? '').trim() === n)
    if (byName) return byName
  }
  return null
}

/** Build the MISP sync-server body from canvas fields (wrapped in `{ Server: {...} }` by callers). */
export function buildServerFields(fields: Record<string, unknown>): MispServer {
  return {
    name: String(fields.name ?? '').trim(),
    url: String(fields.url ?? '').trim(),
    authkey: String(fields.authkey ?? '').trim(),
    pull: normalizeYesNo(fields.pull),
    push: normalizeYesNo(fields.push),
  }
}
