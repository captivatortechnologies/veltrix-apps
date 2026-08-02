import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCriblUrl, criblConnect, sendJson, groupResourcePath } from '../../lib/criblApi'
import { buildPipelineBody, type CriblPipeline } from './_shared'

/**
 * Undo a pipelines deploy from rollbackData.previous (written by deploy()): for
 * each entry, restore the prior pipeline config (PATCH /pipelines/<id>), or —
 * when the pipeline was newly created (prior null) — remove it
 * (DELETE /pipelines/<id>). Applied over the Cribl REST API. Verify against a
 * live Cribl.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ id: string; group: string; pipeline: CriblPipeline | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for pipeline rollback' }
  }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)

  let restored = 0
  let removed = 0
  try {
    const headers = await criblConnect(base, credential)

    for (const { id, group, pipeline } of previous) {
      if (!id) continue
      const url = `${groupResourcePath(base, group, 'pipelines')}/${encodeURIComponent(id)}`
      if (pipeline) {
        await sendJson('PATCH', url, headers, buildPipelineBody(id, pipeline.conf ?? { functions: [] }))
        restored++
      } else {
        await sendJson('DELETE', url, headers)
        removed++
      }
    }
    return { success: true, message: `Rolled back pipelines: ${restored} restored, ${removed} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
