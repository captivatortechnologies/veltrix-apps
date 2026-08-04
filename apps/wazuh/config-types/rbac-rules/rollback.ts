import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, sendJson, wazuhRequest } from '../../lib/wazuhApi'
import type { RollbackEntry } from './deploy'

/**
 * Undo an RBAC-rule deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT the prior `rule` body back, or — when the rule was newly
 * created (`created` true) — DELETE it. Applied over the Wazuh REST API (55000).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for RBAC-rule rollback' }
  }

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    for (const entry of previous) {
      if (entry.id == null) {
        skipped++
        continue
      }
      if (entry.created) {
        const url = `${baseUrl}/security/rules?rule_ids=${entry.id}`
        const res = await wazuhRequest(url, { method: 'DELETE', headers: auth })
        if (!res.ok && res.status !== 404) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        deleted++
      } else if (entry.priorRule) {
        await sendJson('PUT', `${baseUrl}/security/rules/${entry.id}`, auth, { name: entry.name, rule: entry.priorRule })
        restored++
      } else {
        skipped++
      }
    }
    return { success: true, message: `Rolled back RBAC rules: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
