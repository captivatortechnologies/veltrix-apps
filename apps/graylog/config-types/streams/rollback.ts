import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import type { GraylogStream } from './_shared'

/**
 * Undo a streams deploy from rollbackData.previous (written by deploy()): for each
 * entry, PUT /api/streams/{id} with the prior stream body (restore), or — when the
 * stream was newly created (prior body null) — DELETE /api/streams/{id} to remove
 * it. Applied over the Graylog REST API. Verify against a live Graylog instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ title: string; streamId: string | null; stream: GraylogStream | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for stream rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { streamId, stream } of previous) {
      if (!streamId) {
        // A created stream whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/api/streams/${encodeURIComponent(streamId)}`
      if (stream) {
        // Restore the prior body. Strip server-managed fields Graylog rejects on PUT.
        const { id, disabled, creator_user_id, created_at, ...body } = stream
        void id
        void disabled
        void creator_user_id
        void created_at
        await sendJson('PUT', path, headers, body)
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back streams: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
