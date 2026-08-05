// =============================================================================
// Shared helpers for the Sophos Central Custom Roles config type.
//
// A role is reconciled by `name` — Sophos assigns the id on create.
// `principalType` is immutable after creation (PATCH only accepts
// name/description/permissionSets — a JSON Merge Patch, so permissionSets is
// always a whole-list replace, never a per-item add/remove).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canonicalJson, splitList, str } from '../../lib/sophosCommon'
import type { SophosRole } from '../../lib/sophosApi'

export interface CustomRoleSpec {
  itemName: string
  name: string
  description: string
  principalType: string
  permissionSets: string[]
}

/** The role's logical identity: its name, trimmed and lower-cased for matching. */
export function customRoleKey(name: string): string {
  return name.trim().toLowerCase()
}

export function extractCustomRoleSpecs(canvas: CanvasSnapshot): CustomRoleSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: str(fields.name),
      description: str(fields.description),
      principalType: str(fields.principalType),
      permissionSets: splitList(fields.permissionSets),
    }
  })
}

/** Build the create request body from a declared spec. */
export function buildCustomRoleCreateBody(spec: CustomRoleSpec): Pick<SophosRole, 'name' | 'principalType' | 'permissionSets' | 'description'> {
  return { name: spec.name, principalType: spec.principalType, permissionSets: spec.permissionSets, description: spec.description || undefined }
}

/** Build the PATCH body (name/description/permissionSets only — principalType is immutable). */
export function buildCustomRolePatchBody(spec: CustomRoleSpec): Pick<SophosRole, 'name' | 'permissionSets' | 'description'> {
  return { name: spec.name, permissionSets: spec.permissionSets, description: spec.description || '' }
}

/** Does the live role already match the declared name/description/permissionSets? */
export function customRoleMatches(spec: CustomRoleSpec, live: SophosRole): boolean {
  const expected = { name: spec.name, description: spec.description || '', permissionSets: [...spec.permissionSets].sort() }
  const actual = { name: live.name, description: live.description || '', permissionSets: [...(live.permissionSets ?? [])].sort() }
  return canonicalJson(expected) === canonicalJson(actual)
}
