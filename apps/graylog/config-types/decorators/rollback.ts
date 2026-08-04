import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveDecorator, type GraylogDecorator } from './_shared'

/**
 * Undo a decorators deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /api/search/decorators/{id} with the prior config
 * (restore), or — when the decorator was newly created (prior null) — DELETE
 * /api/search/decorators/{id} to remove it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ type: string; streamId: string; decoratorId: string | null; decorator: GraylogDecorator | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for decorator rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { decoratorId, decorator } of previous) {
      if (!decoratorId) {
        skipped++
        continue
      }
      const path = `${base}/api/search/decorators/${encodeURIComponent(decoratorId)}`
      if (decorator) {
        await sendJson('PUT', path, headers, bodyFromLiveDecorator(decorator))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back decorators: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
