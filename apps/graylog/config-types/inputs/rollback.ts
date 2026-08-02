import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveInput, type GraylogInput } from './_shared'

/**
 * Undo an inputs deploy from rollbackData.previous (written by deploy()): for each
 * entry, PUT /api/system/inputs/{id} with the prior input body (restore — the live
 * config comes back under `attributes`, mapped to `configuration` by
 * bodyFromLiveInput), or — when the input was newly created (prior null) — DELETE
 * /api/system/inputs/{id} to remove it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ title: string; inputId: string | null; input: GraylogInput | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for input rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { inputId, input } of previous) {
      if (!inputId) {
        skipped++
        continue
      }
      const path = `${base}/api/system/inputs/${encodeURIComponent(inputId)}`
      if (input) {
        await sendJson('PUT', path, headers, bodyFromLiveInput(input))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back inputs: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
