// Shared helpers for the JumpCloud System Groups config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// System Groups are JumpCloud's DEVICE groups, applied over the API v2
// (/systemgroups). The POST/PUT body model is `SystemGroupData`; the public
// jcapi model markdown documents `name` (verified) and this config type also
// sends `description` — verify `description` against a live JumpCloud tenant.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** One JumpCloud System Group as returned by GET /systemgroups and GET /systemgroups/{id}. */
export interface JumpCloudSystemGroup {
  id?: string
  name?: string
  description?: string
  /** Always "system_group" for this endpoint. */
  type?: string
  [key: string]: unknown
}

/** The desired state for one System Group, extracted from a canvas item. */
export interface SystemGroupSpec {
  /** Stable canvas item id — survives renames; used to match a live group by the
   *  external id stored from the prior deploy (rename-safe identity). */
  itemId?: string
  /** Group name — the logical identity live groups are matched on. */
  name: string
  description: string
}

/** Each canvas item describes one JumpCloud System Group. */
export function extractSystemGroupSpecs(canvas: CanvasSnapshot): SystemGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(fields.name ?? '').trim(),
      description: String(fields.description ?? '').trim(),
    }
  })
}

/** Find a live System Group by name (case-insensitive — the stable identity). */
export function findSystemGroupByName(
  groups: JumpCloudSystemGroup[],
  name: string,
): JumpCloudSystemGroup | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return groups.find((g) => String(g.name ?? '').trim().toLowerCase() === target) ?? null
}

/**
 * Build the JumpCloud System Group body for POST/PUT /systemgroups.
 * `name` is always sent. `description` is always sent (empty string clears it) so
 * a PUT converges the live group and drift agrees about the target state.
 */
export function buildSystemGroupBody(spec: SystemGroupSpec): Record<string, unknown> {
  return { name: spec.name, description: spec.description }
}

/** The subset of a live group's fields this config type manages — captured for rollback. */
export function priorFieldsOf(group: JumpCloudSystemGroup): Record<string, unknown> {
  return { name: String(group.name ?? ''), description: String(group.description ?? '') }
}
