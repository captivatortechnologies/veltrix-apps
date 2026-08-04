import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'
import type { MispTag } from './_shared'

/**
 * Undo a tags deploy from rollbackData.previous (written by deploy()): for each
 * entry with a prior body, POST /tags/edit/<id> to restore it; a newly created
 * tag (prior body null) is hard-deleted via POST /tags/delete/<id> — unlike
 * sharing groups/organisations/sync servers, MISP tags have a real delete
 * endpoint, so rollback can fully undo a create. Applied over the MISP REST API
 * (443). Verify /tags/edit/<id> + /tags/delete/<id> against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; tagId: number | string | null; tag: MispTag | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for tag rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { tagId, tag } of previous) {
      if (tagId == null) continue // never learned an id — nothing addressable to undo
      if (tag) {
        await sendJson('POST', `${base}/tags/edit/${encodeURIComponent(String(tagId))}`, headers, { Tag: tag })
        restored++
      } else {
        await sendJson('POST', `${base}/tags/delete/${encodeURIComponent(String(tagId))}`, headers, {})
        deleted++
      }
    }
    return { success: true, message: `Rolled back tags: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
