// Shared helpers for the Sysdig Secure Falco Lists config type
// (validate + deploy + rollback + drift).
//
// List shapes follow the Sysdig Secure /api/secure/falco/lists API (confirmed
// against terraform-provider-sysdig model.go + python-sdc-client). Verify
// against a live Sysdig Secure.

import type { SysdigList } from '../../lib/sysdigApi'

/** The canvas fields for one Falco list item. */
export interface FalcoListFields {
  name?: unknown
  items?: unknown
  enabled?: unknown
}

/**
 * `enabled` may arrive as a boolean, an 'enabled'/'disabled' string, or 1|0 —
 * normalize to a boolean. Defaults to enabled.
 */
export function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'disabled' || s === 'false' || s === '0' || s === 'no') return false
  return true
}

/** Split a comma/newline separated items value (or array) into trimmed strings. */
export function splitItems(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * Build the Sysdig list body from canvas fields. `append: false` means this app
 * owns the full item set for the list (a managed, not appended, list).
 */
export function buildListBody(fields: FalcoListFields): SysdigList {
  return {
    name: String(fields.name ?? '').trim(),
    items: { items: splitItems(fields.items) },
    append: false,
  }
}

/** Find a live custom Falco list by exact name (case-sensitive, as Sysdig stores it). */
export function findListByName(lists: SysdigList[], name: string): SysdigList | null {
  const n = name.trim()
  if (!n) return null
  return lists.find((l) => String(l.name ?? '').trim() === n) ?? null
}

/** The sorted item set of a live list, for stable comparison. */
export function itemsOf(list: SysdigList | null): string[] {
  return [...(list?.items?.items ?? [])].map((v) => String(v).trim()).filter(Boolean).sort()
}
