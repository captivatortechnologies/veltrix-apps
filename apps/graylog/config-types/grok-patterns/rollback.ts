import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveGrokPattern, type GraylogGrokPattern } from './_shared'

/**
 * Undo a grok-patterns deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /api/system/grok/{id} with the prior pattern definition
 * (restore), or — when the pattern was newly created (prior null) — DELETE
 * /api/system/grok/{id} to remove it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; patternId: string | null; pattern: GraylogGrokPattern | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for grok-pattern rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { patternId, pattern } of previous) {
      if (!patternId) {
        skipped++
        continue
      }
      const path = `${base}/api/system/grok/${encodeURIComponent(patternId)}`
      if (pattern) {
        await sendJson('PUT', path, headers, bodyFromLiveGrokPattern(pattern))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back grok patterns: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
