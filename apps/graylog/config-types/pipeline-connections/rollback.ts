import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import type { GraylogPipelineConnections } from './_shared'

/**
 * Undo a pipeline-connections deploy from rollbackData.previous (written by
 * deploy()): for each stream, POST /api/system/pipelines/connections/to_stream
 * with the PRIOR pipeline_ids set (empty array when the stream had no
 * connections before deploy — Graylog has no delete for this resource, only
 * whole-value replace).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ streamTitle: string; streamId: string; connections: GraylogPipelineConnections | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for pipeline-connection rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  try {
    for (const { streamId, connections } of previous) {
      if (!streamId) continue
      await sendJson('POST', `${base}/api/system/pipelines/connections/to_stream`, headers, {
        stream_id: streamId,
        pipeline_ids: connections?.pipeline_ids ?? [],
      })
      restored++
    }
    return { success: true, message: `Rolled back pipeline connections for ${restored} stream(s).` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
