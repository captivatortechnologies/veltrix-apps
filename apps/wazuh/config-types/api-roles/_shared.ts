// Shared helpers for the Wazuh API-roles config type (validate + deploy +
// drift). A role is a name plus a set of attached policies and RBAC rules —
// both many-to-many relationships resolved by NAME against the API Policies /
// RBAC Rules config types. The canvas `comment` field is audit-only and is
// never sent to the manager.
//
// Field shapes verified against the Wazuh API OpenAPI spec (api/api/spec/spec.yaml,
// tag v4.14.7, github.com/wazuh/wazuh) — `RolesRequest` schema (name only; a
// role's policies/rules are relationship endpoints, not body fields) and the
// `/security/roles/{role_id}/policies` + `/security/roles/{role_id}/rules`
// set/unset relationship endpoints.

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'

/** A role/policy/rule name: Wazuh's `names` OpenAPI format (`^[\w.%-]+$`, ASCII). */
export const NAME_RE = /^[\w.%-]+$/
export const MAX_NAME_LENGTH = 64

export interface RoleSpec {
  name: string
  policyNames: string[]
  ruleNames: string[]
  comment: string
}

function readTagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return []
}

export function specFromItem(item: CanvasItemSnapshot): RoleSpec {
  return {
    name: String(item.fields.name ?? '').trim(),
    policyNames: readTagList(item.fields.policies),
    ruleNames: readTagList(item.fields.rules),
    comment: String(item.fields.comment ?? '').trim(),
  }
}

/** Ids to add and remove to turn `current` into exactly `desired` (both sets of numeric ids). */
export function diffIdSets(current: number[], desired: number[]): { toAdd: number[]; toRemove: number[] } {
  const currentSet = new Set(current)
  const desiredSet = new Set(desired)
  return {
    toAdd: desired.filter((id) => !currentSet.has(id)),
    toRemove: current.filter((id) => !desiredSet.has(id)),
  }
}

/**
 * Resolve every NAME in `names` to its id via `byName`; throws listing every
 * unresolvable name in one error so an operator sees the full problem at once,
 * not one name per deploy attempt.
 */
export function resolveNamesToIds(names: string[], byName: Map<string, number>, kind: string): number[] {
  const missing = names.filter((n) => !byName.has(n))
  if (missing.length) {
    throw new Error(`${kind} not found in Wazuh: ${missing.join(', ')}`)
  }
  return names.map((n) => byName.get(n) as number)
}
