import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'

/**
 * Undo a data-forwarding-rules deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /logsDataForwarding/rules/<indexId> with the
 * prior mutable-subset body (restore), or — when the rule was newly created
 * (prior body null) — DELETE /logsDataForwarding/rules/<indexId> to remove it.
 * Applied over the Sumo Logic Management API.
 *
 * API: https://help.sumologic.com/docs/api/data-forwarding/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ indexId: string; priorBody: Record<string, unknown> | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for data forwarding rule rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  try {
    for (const { indexId, priorBody } of previous) {
      const path = `${base}/logsDataForwarding/rules/${encodeURIComponent(indexId)}`
      if (priorBody) {
        await sendJson('PUT', path, headers, priorBody)
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return { success: true, message: `Rolled back data forwarding rules: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
