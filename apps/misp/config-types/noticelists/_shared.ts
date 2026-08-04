// Shared helpers for the MISP Noticelists config type (deploy + rollback + drift).
//
// MISP noticelist shapes follow the 2.4 REST API (/noticelists/index,
// /noticelists/enableNoticelist/{id}[/true]); verify against a live MISP 2.4
// instance.

/** Valid noticelist enable states from the canvas. */
export const NOTICELIST_STATES = new Set(['enabled', 'disabled'])

/** One MISP noticelist as returned inside a `{ Noticelist: {...} }` envelope by /noticelists. */
export interface MispNoticelist {
  id?: number | string
  name?: string
  expanded_name?: string
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

/** Coerce a MISP list response into rows (a bare array or a `{ response: [...] }` wrapper). */
function asRows(list: unknown): unknown[] {
  if (Array.isArray(list)) return list
  if (list && typeof list === 'object' && Array.isArray((list as { response?: unknown }).response)) {
    return (list as { response: unknown[] }).response
  }
  return []
}

/** Unwrap MISP's `[{ Noticelist: {...} }]` list into a flat array of noticelists. */
export function noticelistsFromList(list: unknown): MispNoticelist[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'Noticelist' in (row as Record<string, unknown>)
      ? ((row as { Noticelist: MispNoticelist }).Noticelist)
      : (row as MispNoticelist),
  )
}

/** Find a live noticelist by name (case-insensitive — the stable identity). */
export function findNoticelist(noticelists: MispNoticelist[], name: string): MispNoticelist | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return noticelists.find((nl) => String(nl.name ?? '').trim().toLowerCase() === n) ?? null
}
