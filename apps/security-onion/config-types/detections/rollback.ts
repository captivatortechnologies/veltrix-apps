import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSocUrl, buildAuthHeader, sendJson } from '../../lib/soConsole'

/**
 * Undo a detections deploy from rollbackData.previous (written by deploy()): for
 * each entry, PUT the prior rule body back, or DELETE the rule we created (its
 * prior body was null). Applied over the SOC console REST API (443).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ ruleId: string; rule: Record<string, unknown> | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for detection rule rollback' }
  }

  const base = buildSocUrl(component, connectivity, connectivityProvider)
  const headers = { ...buildAuthHeader(credential), 'kbn-xsrf': 'true' }

  let restored = 0
  let deleted = 0
  try {
    for (const { ruleId, rule } of previous) {
      if (rule) {
        await sendJson('PUT', `${base}/api/detection_engine/rules`, headers, rule)
        restored++
      } else {
        await sendJson('DELETE', `${base}/api/detection_engine/rules?rule_id=${encodeURIComponent(ruleId)}`, headers)
        deleted++
      }
    }
    return { success: true, message: `Rolled back detection rules: ${restored} restored, ${deleted} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
