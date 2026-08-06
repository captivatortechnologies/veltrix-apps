// =============================================================================
// Shared helpers for the GravityZone Network Groups config type.
//
// Network groups are reconciled by the pair (groupName, parentId) — GravityZone
// assigns the group id on create and has no rename API, so this app treats
// groupName as create-only identity within a fixed parent scope.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { coerceBoolean, str } from '../../lib/gravityZoneCommon'
import type { GzCustomGroup } from '../../lib/gravityZoneApi'

export interface NetworkGroupSpec {
  itemName: string
  groupName: string
  parentId: string
  force: boolean
}

/** The group's logical identity within its declared parent: its name, trimmed and lower-cased for matching. */
export function networkGroupKey(groupName: string): string {
  return groupName.trim().toLowerCase()
}

export function extractNetworkGroupSpecs(canvas: CanvasSnapshot): NetworkGroupSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      groupName: str(fields.groupName),
      parentId: str(fields.parentId),
      force: coerceBoolean(fields.force, false),
    }
  })
}

/** Find a live group (among a specific parent's direct children) by name. */
export function findLiveGroup(live: GzCustomGroup[], groupName: string): GzCustomGroup | undefined {
  const key = networkGroupKey(groupName)
  return live.find((g) => networkGroupKey(g.name ?? g.groupName ?? '') === key)
}

/** The live group's GravityZone-assigned id, read defensively (see lib/gravityZoneCommon.ts readId). */
export function liveGroupId(group: GzCustomGroup): string {
  const id = group.id ?? group.groupId
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : ''
}
