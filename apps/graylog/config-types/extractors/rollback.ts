import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveExtractor, type GraylogExtractor } from './_shared'

/**
 * Undo an extractors deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT .../inputs/{inputId}/extractors/{id} with the prior
 * extractor body (restore), or — when the extractor was newly created (prior
 * null) — DELETE .../inputs/{inputId}/extractors/{id} to remove it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ inputTitle: string; title: string; inputId: string; extractorId: string | null; extractor: GraylogExtractor | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for extractor rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { inputId, extractorId, extractor } of previous) {
      if (!inputId || !extractorId) {
        skipped++
        continue
      }
      const path = `${base}/api/system/inputs/${encodeURIComponent(inputId)}/extractors/${encodeURIComponent(extractorId)}`
      if (extractor) {
        await sendJson('PUT', path, headers, bodyFromLiveExtractor(extractor))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back extractors: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
