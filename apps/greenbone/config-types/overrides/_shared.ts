// Shared helpers for the Greenbone Overrides config type (deploy + rollback +
// drift). An override has no name field at all — this config type tracks
// identity by the CANVAS ITEM's own stable id across deploys (the same
// pattern apps/pfsense/config-types/static-routes uses for a GMP-shaped
// resource with no name field), recorded in rollbackData.

import type { CanvasItemSnapshot, CanvasSnapshot, PlatformDataApi } from '@veltrixsecops/app-sdk'
import type { OverrideInput } from '../../lib/gmp/overrides'

export interface OverrideSpec extends OverrideInput {
  itemId: string
}

export function specFromItem(item: CanvasItemSnapshot): OverrideSpec {
  const f = item.fields ?? {}
  const severity = f.severity !== undefined && f.severity !== '' ? Number(f.severity) : undefined
  const daysActive = f.daysActive !== undefined && f.daysActive !== '' ? Number(f.daysActive) : undefined
  return {
    itemId: item.id ?? item.name,
    text: String(f.text ?? '').trim(),
    nvtOid: String(f.nvtOid ?? '').trim(),
    hosts: String(f.hosts ?? '').trim(),
    port: String(f.port ?? '').trim(),
    severity,
    newSeverity: Number(f.newSeverity),
    daysActive,
    taskId: String(f.taskId ?? '').trim(),
    resultId: String(f.resultId ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): OverrideSpec[] {
  return items.map(specFromItem)
}

export interface RollbackEntry {
  itemId: string
  overrideId: string
  prior: OverrideInput | null
}

/** The last successfully-deployed itemId -> gvmd override id map, shared by deploy/rollback/drift. */
export async function loadPriorEntries(platform: PlatformDataApi, canvas: CanvasSnapshot): Promise<RollbackEntry[]> {
  try {
    const prev = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { previous?: RollbackEntry[] } | undefined
    return Array.isArray(data?.previous) ? data.previous : []
  } catch {
    return []
  }
}
