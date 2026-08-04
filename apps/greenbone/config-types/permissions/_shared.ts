// Shared helpers for the Greenbone Permissions config type (deploy + rollback
// + drift). A permission has no natural name — its `name` field is the
// granted COMMAND name (e.g. "get_tasks"), not a unique label, and gvmd does
// not enforce (name, subject, resource) uniqueness. This config type
// therefore tracks identity by the CANVAS ITEM's own stable id across
// deploys (the same pattern apps/pfsense/config-types/static-routes uses for
// a GMP-shaped resource with no name field), recorded in rollbackData.

import type { CanvasItemSnapshot, CanvasSnapshot, PlatformDataApi } from '@veltrixsecops/app-sdk'
import type { PermissionInput } from '../../lib/gmp/permissions'

export interface PermissionSpec extends PermissionInput {
  itemId: string
}

export function specFromItem(item: CanvasItemSnapshot): PermissionSpec {
  const f = item.fields ?? {}
  return {
    itemId: item.id ?? item.name,
    name: String(f.name ?? '').trim(),
    subjectId: String(f.subjectId ?? '').trim(),
    subjectType: String(f.subjectType ?? '').trim(),
    resourceId: String(f.resourceId ?? '').trim(),
    resourceType: String(f.resourceType ?? '').trim(),
    comment: String(f.comment ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): PermissionSpec[] {
  return items.map(specFromItem)
}

export interface RollbackEntry {
  itemId: string
  permissionId: string
  prior: PermissionInput | null
}

/** The last successfully-deployed itemId -> gvmd permission id map, shared by deploy/rollback/drift. */
export async function loadPriorEntries(platform: PlatformDataApi, canvas: CanvasSnapshot): Promise<RollbackEntry[]> {
  try {
    const prev = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { previous?: RollbackEntry[] } | undefined
    return Array.isArray(data?.previous) ? data.previous : []
  } catch {
    return []
  }
}
