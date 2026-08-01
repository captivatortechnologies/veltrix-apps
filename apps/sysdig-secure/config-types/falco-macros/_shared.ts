// Shared helpers for the Sysdig Secure Falco Macros config type
// (validate + deploy + rollback + drift).
//
// Macro shapes follow the Sysdig Secure /api/secure/falco/macros API (confirmed
// against terraform-provider-sysdig model.go + python-sdc-client). Verify
// against a live Sysdig Secure.

import type { SysdigMacro } from '../../lib/sysdigApi'

/** The canvas fields for one Falco macro item. */
export interface FalcoMacroFields {
  name?: unknown
  condition?: unknown
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

/**
 * Build the Sysdig macro body from canvas fields. `append: false` means this app
 * owns the full condition for the macro (a managed, not appended, macro).
 */
export function buildMacroBody(fields: FalcoMacroFields): SysdigMacro {
  return {
    name: String(fields.name ?? '').trim(),
    condition: { condition: String(fields.condition ?? '').trim() },
    append: false,
  }
}

/** Find a live custom Falco macro by exact name (case-sensitive, as Sysdig stores it). */
export function findMacroByName(macros: SysdigMacro[], name: string): SysdigMacro | null {
  const n = name.trim()
  if (!n) return null
  return macros.find((m) => String(m.name ?? '').trim() === n) ?? null
}

/** The condition expression of a live macro (unwrapped from its object). */
export function conditionOf(macro: SysdigMacro | null): string {
  return String(macro?.condition?.condition ?? '').trim()
}
