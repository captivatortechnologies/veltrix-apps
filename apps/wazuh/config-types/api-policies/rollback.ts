import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, sendJson, wazuhRequest } from '../../lib/wazuhApi'
import type { RollbackEntry } from './deploy'

/**
 * Undo an API-policy deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT the prior `policy` body back, or — when the policy was
 * newly created (`created` true) — DELETE it. Applied over the Wazuh REST API
 * (55000).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for API-policy rollback' }
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
        const url = `${baseUrl}/security/policies?policy_ids=${entry.id}`
        const res = await wazuhRequest(url, { method: 'DELETE', headers: auth })
        if (!res.ok && res.status !== 404) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        deleted++
      } else if (entry.priorPolicy) {
        await sendJson('PUT', `${baseUrl}/security/policies/${entry.id}`, auth, { name: entry.name, policy: entry.priorPolicy })
        restored++
      } else {
        skipped++
      }
    }
    return { success: true, message: `Rolled back API policies: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
