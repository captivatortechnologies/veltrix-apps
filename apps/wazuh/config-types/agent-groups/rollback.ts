import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, wazuhRequest } from '../../lib/wazuhApi'

/**
 * Undo an agent-group deploy from rollbackData.previous (written by deploy()): a
 * group we created is removed (DELETE /groups?groups_list=<group>); a pre-existing
 * group has its prior agent.conf PUT back (skipped when the prior body was
 * unreadable). Applied over the Wazuh REST API (55000).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ groupName: string; created: boolean; conf: string | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for agent-group rollback' }
  }

  let restored = 0
  let deleted = 0
  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    for (const { groupName, created, conf } of previous) {
      if (created) {
        const url = `${baseUrl}/groups?groups_list=${encodeURIComponent(groupName)}`
        const res = await wazuhRequest(url, { method: 'DELETE', headers: auth })
        if (!res.ok && res.status !== 404) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        deleted++
      } else if (conf != null) {
        const url = `${baseUrl}/groups/${encodeURIComponent(groupName)}/configuration`
        const res = await wazuhRequest(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/xml', ...auth },
          body: conf,
        })
        if (!res.ok) throw new Error(`PUT ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        restored++
      }
    }
    return { success: true, message: `Rolled back agent groups: ${restored} restored, ${deleted} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
