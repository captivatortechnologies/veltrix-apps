import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveOutput, type GraylogOutput } from './_shared'

/**
 * Undo an outputs deploy from rollbackData.previous (written by deploy()): for
 * each entry, PUT /api/system/outputs/{id} with the prior configuration
 * (restore), or — when the output was newly created (prior null) — DELETE
 * /api/system/outputs/{id} to remove it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ title: string; outputId: string | null; output: GraylogOutput | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for output rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { outputId, output } of previous) {
      if (!outputId) {
        skipped++
        continue
      }
      const path = `${base}/api/system/outputs/${encodeURIComponent(outputId)}`
      if (output) {
        await sendJson('PUT', path, headers, bodyFromLiveOutput(output))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back outputs: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
