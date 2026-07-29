import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildEsUrl, buildAuthHeader, sendJson } from '../../lib/soConsole'

/**
 * Undo an ILM deploy from rollbackData.previous (written by deploy()): for each
 * entry, PUT the prior policy body back, or DELETE the policy we created (its
 * prior body was null). Applied over the Elasticsearch REST API (9200).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ policyName: string; policy: Record<string, unknown> | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for ILM policy rollback' }
  }

  const esUrl = buildEsUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { policyName, policy } of previous) {
      const path = `${esUrl}/_ilm/policy/${encodeURIComponent(policyName)}`
      if (policy) {
        await sendJson('PUT', path, auth, { policy })
        restored++
      } else {
        await sendJson('DELETE', path, auth)
        deleted++
      }
    }
    return { success: true, message: `Rolled back ILM policies: ${restored} restored, ${deleted} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
