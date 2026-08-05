// =============================================================================
// Shared canvas-field parsing helpers, used across every Aqua Security
// config type (assurance policies, runtime policies, firewall policies,
// application scopes, enforcer groups). Kept in one place so a parsing fix
// lands everywhere at once.
// =============================================================================

import type { AquaLabel, AquaScope, AquaScopeVariable } from '../../lib/aquasec'

/** Split a `tags`/`multiselect` value (array), or a comma/newline string, into trimmed strings. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/** Read a `keyvalue` canvas field (a plain object) into a stable-ordered [key, value][] list. */
export function keyvalueEntries(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => [k.trim(), String(v ?? '').trim()] as [string, string])
    .filter(([k]) => k.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
}

/** Boolean canvas value, defaulting when absent (checkbox fields always arrive as booleans, but be lenient). */
export function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return fallback
}

/** Numeric canvas value, defaulting when absent/invalid. */
export function normalizeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

/** Build a scope-variable list from a `keyvalue` field: {attribute -> value} pairs. */
export function toScopeVariables(value: unknown): AquaScopeVariable[] {
  return keyvalueEntries(value).map(([attribute, val]) => ({ attribute, value: val }))
}

/** Build an Aqua boolean-expression scope from a textarea expression + keyvalue variables. */
export function buildScope(expressionValue: unknown, variablesValue: unknown): AquaScope | undefined {
  const expression = String(expressionValue ?? '').trim()
  const variables = toScopeVariables(variablesValue)
  if (!expression && variables.length === 0) return undefined
  return { expression, variables }
}

/** Build a label list from a `keyvalue` field: {key -> value} pairs. */
export function toLabels(value: unknown): AquaLabel[] {
  return keyvalueEntries(value).map(([key, val]) => ({ key, value: val }))
}

/** Order-insensitive equality for two string lists. */
export function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((v) => setA.has(v))
}

/** Sorted, comparable rendering of a string list, for diff display. */
export function displayList(values: string[] | undefined): string {
  return [...(values ?? [])].map((v) => String(v).trim()).filter(Boolean).sort().join(', ')
}

/** Order-insensitive equality for two scope-variable lists (by attribute+value pair). */
export function sameScope(a: AquaScope | undefined, b: AquaScope | undefined): boolean {
  const expA = (a?.expression ?? '').trim()
  const expB = (b?.expression ?? '').trim()
  if (expA !== expB) return false
  const varsA = [...(a?.variables ?? [])].map((v) => `${v.attribute}=${v.value}`).sort()
  const varsB = [...(b?.variables ?? [])].map((v) => `${v.attribute}=${v.value}`).sort()
  return varsA.join('|') === varsB.join('|')
}

/** Human-readable rendering of a scope, for diff display. */
export function displayScope(scope: AquaScope | undefined): string {
  if (!scope) return '(none)'
  const vars = [...(scope.variables ?? [])].map((v) => `${v.attribute}=${v.value}`).sort().join(', ')
  return `${scope.expression || '(empty)'}${vars ? ` [${vars}]` : ''}`
}

/** Order-insensitive equality for two label lists (by key+value pair). */
export function sameLabels(a: AquaLabel[] | undefined, b: AquaLabel[] | undefined): boolean {
  const la = [...(a ?? [])].map((l) => `${l.key}=${l.value}`).sort()
  const lb = [...(b ?? [])].map((l) => `${l.key}=${l.value}`).sort()
  return la.join('|') === lb.join('|')
}

/** Human-readable rendering of a label list, for diff display. */
export function displayLabels(labels: AquaLabel[] | undefined): string {
  return [...(labels ?? [])].map((l) => `${l.key}=${l.value}`).sort().join(', ')
}

// --- Rollback bookkeeping shared by every config type's deploy/rollback ----

export type UpsertAction = 'created' | 'updated' | 'deleted' | 'noop'

export interface RollbackEntry<T> {
  name: string
  action: UpsertAction
  /** The live object BEFORE this deploy (null when it did not previously exist). */
  prior: T | null
}
