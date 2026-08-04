// Shared helpers for the JumpCloud Policy Groups config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// Policy Groups bundle Policies together for one-step binding to a User Group /
// System Group. Applied over the JumpCloud API v2 (/policygroups).
//
// VERIFIED against JumpCloud's published API v2 OpenAPI spec
// (github.com/TheJumpCloud/jumpcloud-docs-public, docs/api/2.0/index.yaml):
//   PolicyGroupData (POST/PUT body): { name } — the ONLY writable field; the
//     response model additionally exposes `description` / `email`, but those
//     are NOT accepted on write (confirmed from the request schema, not just
//     inferred), so this config type does not attempt to manage them.
//   Members op ({ op: "add" | "remove" | "update", type: "policy", id }) — the
//     same GraphManagementReq-style operation used by User Group Memberships.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** One JumpCloud Policy Group as returned by GET /policygroups and GET /policygroups/{id}. */
export interface JumpCloudPolicyGroup {
  id?: string
  name?: string
  description?: string
  /** Always "policy" for a Policy Group. */
  type?: string
  [key: string]: unknown
}

/** A minimal Policy reference, for resolving declared member names to ids. */
export interface JumpCloudPolicyRef {
  id?: string
  name?: string
}

/** A member connection as returned by GET /policygroups/{id}/members. */
export interface GraphConnection {
  to?: { id?: string; type?: string; [key: string]: unknown }
  id?: string
  type?: string
  [key: string]: unknown
}

/** The desired state for one Policy Group, extracted from a canvas item. */
export interface PolicyGroupSpec {
  /** Stable canvas item id — survives renames; used for rename-safe identity. */
  itemId?: string
  /** Policy Group name — the logical identity live groups are matched on. */
  name: string
  /** Declared member Policy names — this canvas item owns the FULL membership. */
  memberPolicies: string[]
}

/** Split a memberPolicies value (a tags array or a newline/comma string) into trimmed entries. */
export function toPolicyNameList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const s = String(entry ?? '').trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/** Each canvas item describes one JumpCloud Policy Group. */
export function extractPolicyGroupSpecs(canvas: CanvasSnapshot): PolicyGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(fields.name ?? '').trim(),
      memberPolicies: toPolicyNameList(fields.memberPolicies),
    }
  })
}

/** Find a live Policy Group by name (case-insensitive — the stable identity). */
export function findPolicyGroupByName(groups: JumpCloudPolicyGroup[], name: string): JumpCloudPolicyGroup | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return groups.find((g) => String(g.name ?? '').trim().toLowerCase() === target) ?? null
}

/** Find a Policy by name (case-insensitive), for resolving a declared member. */
export function findPolicyRefByName(policies: JumpCloudPolicyRef[], name: string): JumpCloudPolicyRef | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return policies.find((p) => String(p.name ?? '').trim().toLowerCase() === target) ?? null
}

/** Build the JumpCloud Policy Group body for POST/PUT /policygroups. `name` is the only field. */
export function buildPolicyGroupBody(spec: PolicyGroupSpec): Record<string, unknown> {
  return { name: spec.name }
}

/** The subset of a live group's fields this config type manages — captured for rollback. */
export function priorFieldsOf(group: JumpCloudPolicyGroup): Record<string, unknown> {
  return { name: String(group.name ?? '') }
}

/** Extract the member Policy id from a GraphConnection (`to.id`, falling back to a flat `id`). */
export function memberIdOf(connection: GraphConnection): string {
  return String(connection.to?.id ?? connection.id ?? '')
}

export interface MemberDelta {
  toAdd: string[]
  toRemove: string[]
}

/**
 * Compute the add/remove operations to converge live membership on the desired
 * set. Policy Group membership is ALWAYS exclusive — the canvas item owns the
 * group's complete member list, matching how the group itself (name) is fully
 * owned. (Unlike User Group Memberships, there is no additive mode: a Policy
 * Group's entire purpose is to be a well-defined bundle of exactly these Policies.)
 */
export function diffMembers(currentIds: Iterable<string>, desiredIds: Iterable<string>): MemberDelta {
  const current = new Set(currentIds)
  const desired = new Set(desiredIds)
  const toAdd = [...desired].filter((id) => !current.has(id))
  const toRemove = [...current].filter((id) => !desired.has(id))
  return { toAdd, toRemove }
}

/** Build one member operation body for POST /policygroups/{id}/members. */
export function buildMemberOp(op: 'add' | 'remove', policyId: string): Record<string, unknown> {
  return { op, type: 'policy', id: policyId }
}
