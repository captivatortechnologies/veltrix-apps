// Shared helpers for the MISP Warninglists config type (deploy + rollback + drift).
//
// MISP warninglist shapes follow the 2.4 REST API (/warninglists,
// /warninglists/toggleEnable); verify against a live MISP 2.4 instance.

/** Valid warninglist enable states from the canvas. */
export const WARNINGLIST_STATES = new Set(['enabled', 'disabled'])

/** One MISP warninglist as returned inside a `{ Warninglist: {...} }` envelope by /warninglists. */
export interface MispWarninglist {
  id?: number | string
  name?: string
  description?: string
  enabled?: boolean | number | string
  [key: string]: unknown
}

/**
 * `state`/`enabled` may arrive from the canvas as an 'enabled'/'disabled' string
 * or a boolean, or from MISP as a boolean / 1|0 / '1'|'0' — normalize to a boolean.
 */
export function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'enabled' || s === 'true' || s === '1') return true
  return false
}

/** Coerce a MISP list response into rows (a bare array, `{ Warninglists: [...] }`, or `{ response: [...] }`). */
function asRows(list: unknown): unknown[] {
  if (Array.isArray(list)) return list
  if (list && typeof list === 'object') {
    const obj = list as Record<string, unknown>
    if (Array.isArray(obj.Warninglists)) return obj.Warninglists
    if (Array.isArray(obj.response)) return obj.response
  }
  return []
}

/** Unwrap MISP's `[{ Warninglist: {...} }]` list into a flat array of warninglists. */
export function warninglistsFromList(list: unknown): MispWarninglist[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'Warninglist' in (row as Record<string, unknown>)
      ? ((row as { Warninglist: MispWarninglist }).Warninglist)
      : (row as MispWarninglist),
  )
}

/** Find a live warninglist by name (case-insensitive — the stable identity). */
export function findWarninglist(warninglists: MispWarninglist[], name: string): MispWarninglist | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return warninglists.find((w) => String(w.name ?? '').trim().toLowerCase() === n) ?? null
}
