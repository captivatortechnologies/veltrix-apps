// Shared helpers for the HackerOne Scope Exclusions config type (deploy +
// rollback + drift). Pure + network-free so they can be unit-tested.
//
// A Scope Exclusion is a named report category excluded from a program's scope /
// rewards. Its writable attributes are `category` and `details` — HackerOne
// assigns the id; there is no other caller-visible identity, so this reconciles
// by `category` (case-insensitive) within a program.
//   Confirmed: https://api.hackerone.com/customer-resources/ (Scope Exclusions)
//     GET    /programs/{id}/scope_exclusions
//     POST   /programs/{id}/scope_exclusions
//              { data: { type: "scope-exclusion", attributes: { category, details } } }
//     PUT    /programs/{program_id}/scope_exclusions/{id}
//              { data: { type: "scope-exclusion", attributes: { category, details } } }
//     DELETE /programs/{program_id}/scope_exclusions/{id}
//   Required permission: Program Management.
//
// The generic program resolution primitives (handle → id, value coercion) are
// shared with the other config types and live in lib/programScopes.ts.

import type { JsonApiResource } from '../../lib/hackeroneApi'
import { str, normalizeIdentifier } from '../../lib/programScopes'

export { str, groupItemsByProgram, findProgramId, type ProgramResource } from '../../lib/programScopes'

/** JSON:API resource `type` for a scope exclusion. */
export const SCOPE_EXCLUSION_TYPE = 'scope-exclusion'

/** The writable attributes of a HackerOne scope exclusion. */
export interface ScopeExclusionAttributes {
  category: string
  details: string
  [key: string]: unknown
}

/** One live scope exclusion as returned by GET /programs/{id}/scope_exclusions. */
export type LiveScopeExclusion = JsonApiResource<Partial<ScopeExclusionAttributes>>

/** Build the writable exclusion attributes from a canvas item's fields. */
export function buildExclusionAttributes(fields: Record<string, unknown>): ScopeExclusionAttributes {
  return { category: str(fields.category), details: str(fields.details) }
}

/**
 * JSON:API write document for a scope exclusion:
 *   { data: { type: "scope-exclusion", attributes: {...} } }
 */
export function exclusionWriteBody(attributes: Record<string, unknown>): { data: { type: string; attributes: Record<string, unknown> } } {
  return { data: { type: SCOPE_EXCLUSION_TYPE, attributes } }
}

/** Index live scope exclusions by their normalized `category` (the reconciliation key). */
export function exclusionsByCategory(exclusions: LiveScopeExclusion[]): Map<string, LiveScopeExclusion> {
  const map = new Map<string, LiveScopeExclusion>()
  for (const ex of exclusions) {
    const category = normalizeIdentifier(ex.attributes?.category)
    if (category) map.set(category, ex)
  }
  return map
}
