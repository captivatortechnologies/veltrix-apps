// Shared helpers for the Wazuh API-users config type (validate + deploy +
// drift). An API user authenticates against the manager's REST API — this is
// NOT a Wazuh agent, and NOT the credential this app itself uses to reach the
// API (though it manages that same underlying resource). `password` is
// WRITE-ONLY — see the canvas template's help text and deploy.ts's module doc.
// The canvas `comment` field is audit-only and is never sent to the manager.
//
// Field shapes verified against the Wazuh API OpenAPI spec (api/api/spec/spec.yaml,
// tag v4.14.7, github.com/wazuh/wazuh) — POST `/security/users` requires
// `username` (4-64 chars, `names` format) + `password`; PUT `/security/users/{id}`
// accepts `password` only; PUT `/security/users/{id}/run_as?allow_run_as=` toggles
// the flag; `/security/users/{id}/roles` is the set/unset relationship endpoint.

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'

/** A username: Wazuh's `names` OpenAPI format (`^[\w.%-]+$`, ASCII). */
export const USERNAME_RE = /^[\w.%-]+$/
export const MIN_USERNAME_LENGTH = 4
export const MAX_USERNAME_LENGTH = 64

export interface ApiUserSpec {
  username: string
  /** '' = not provided this deploy — WRITE-ONLY, never diffed or persisted. */
  password: string
  allowRunAs: boolean
  roleNames: string[]
  comment: string
}

function readTagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return []
}

export function specFromItem(item: CanvasItemSnapshot): ApiUserSpec {
  return {
    username: String(item.fields.username ?? '').trim(),
    password: String(item.fields.password ?? '').trim(),
    allowRunAs: Boolean(item.fields.allow_run_as ?? false),
    roleNames: readTagList(item.fields.roles),
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
 * unresolvable name in one error so an operator sees the full problem at once.
 */
export function resolveNamesToIds(names: string[], byName: Map<string, number>, kind: string): number[] {
  const missing = names.filter((n) => !byName.has(n))
  if (missing.length) {
    throw new Error(`${kind} not found in Wazuh: ${missing.join(', ')}`)
  }
  return names.map((n) => byName.get(n) as number)
}
