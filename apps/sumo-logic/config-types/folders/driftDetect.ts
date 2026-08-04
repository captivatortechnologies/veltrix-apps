import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson } from '../../lib/sumoLogicApi'
import { findFolderChild, type FolderResponse } from './_shared'

/**
 * Drift for folders: resolve each item's declared parent, match by name within
 * it, then compare the description we declare against the live folder.
 * Best-effort — a folder or parent that can't be read is skipped rather than
 * raising false drift. Read-only: GET /content/folders/<parentId>.
 *
 * API: https://help.sumologic.com/docs/api/content-management/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity, 'v2')
  const headers = buildAuthHeader(credential!)

  const parentCache = new Map<string, FolderResponse | null>()
  async function readParent(parentId: string): Promise<FolderResponse | null> {
    if (parentCache.has(parentId)) return parentCache.get(parentId)!
    try {
      const parent = await getJson<FolderResponse>(`${base}/content/folders/${encodeURIComponent(parentId)}`, headers)
      parentCache.set(parentId, parent)
      return parent
    } catch {
      parentCache.set(parentId, null)
      return null
    }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const parentId = String(item.fields.parentId ?? '').trim()
    if (!name || !parentId) continue

    const parent = await readParent(parentId)
    const child = findFolderChild(parent?.children, name)
    if (!child) continue

    let folder: FolderResponse
    try {
      folder = await getJson<FolderResponse>(`${base}/content/folders/${encodeURIComponent(child.id)}`, headers)
    } catch {
      continue
    }

    const expectedDescription = String(item.fields.description ?? '').trim()
    const actualDescription = String(folder.description ?? '').trim()
    if (actualDescription !== expectedDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
