import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveRule, type GraylogPipelineRule } from './_shared'

/**
 * Undo a pipeline-rules deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /api/system/pipelines/rule/{id} with the prior rule source
 * (restore), or — when the rule was newly created (prior null) — DELETE
 * /api/system/pipelines/rule/{id} to remove it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ title: string; ruleId: string | null; rule: GraylogPipelineRule | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for pipeline-rule rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { ruleId, rule } of previous) {
      if (!ruleId) {
        skipped++
        continue
      }
      const path = `${base}/api/system/pipelines/rule/${encodeURIComponent(ruleId)}`
      if (rule) {
        await sendJson('PUT', path, headers, bodyFromLiveRule(rule))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back pipeline rules: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
