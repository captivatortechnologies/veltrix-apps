import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLivePipeline, type GraylogPipeline } from './_shared'

/**
 * Undo a pipelines deploy from rollbackData.previous (written by deploy()): for
 * each entry, PUT /api/system/pipelines/pipeline/{id} with the prior pipeline
 * source (restore), or — when the pipeline was newly created (prior null) —
 * DELETE /api/system/pipelines/pipeline/{id} to remove it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ title: string; pipelineId: string | null; pipeline: GraylogPipeline | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for pipeline rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { pipelineId, pipeline } of previous) {
      if (!pipelineId) {
        skipped++
        continue
      }
      const path = `${base}/api/system/pipelines/pipeline/${encodeURIComponent(pipelineId)}`
      if (pipeline) {
        await sendJson('PUT', path, headers, bodyFromLivePipeline(pipeline))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back pipelines: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
