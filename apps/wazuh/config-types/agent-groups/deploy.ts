import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, wazuhRequest } from '../../lib/wazuhApi'

/**
 * Deploy Wazuh agent groups over the REST API (55000):
 *   read (rollback): GET ${base}/groups/<group>/configuration        (best-effort — miss = new/empty group)
 *   create:          PUT ${base}/groups?group_id=<group>             ("already exists" is tolerated)
 *   apply conf:      PUT ${base}/groups/<group>/configuration         (raw agent.conf XML — only when supplied)
 *
 * `comment` is audit-only and is never sent to the manager.
 *
 * rollbackData.previous records, per group, whether the create call actually
 * created it (`created`, derived from the create HTTP status) and the prior
 * agent.conf body (`conf`, null when unreadable/new) so rollback can DELETE a
 * freshly created group or PUT the prior config back.
 *
 * NOTE (verify against a live Wazuh 4.x manager): XML bodies + the create/config
 * two-step are assumed; the GET configuration response may be raw XML or wrapped
 * in a { data: { affected_items } } envelope — captured verbatim here for a
 * faithful rollback snapshot.
 */

/** Read the live shared agent.conf (best-effort) for the rollback snapshot; null on any miss. */
async function readGroupConf(base: string, headers: Record<string, string>, group: string): Promise<string | null> {
  try {
    const res = await wazuhRequest(`${base}/groups/${encodeURIComponent(group)}/configuration`, { headers })
    if (!res.ok) return null
    return res.body
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for agent-group deployment' }
  }

  const previous: Array<{ groupName: string; created: boolean; conf: string | null }> = []
  const applied: string[] = []

  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    for (const item of items) {
      const groupName = String(item.fields.groupName ?? '').trim()
      if (!groupName) continue
      const agentConf = String(item.fields.agentConf ?? '')

      const priorConf = await readGroupConf(baseUrl, auth, groupName)

      // Create the group; a group that already exists returns a non-2xx we tolerate.
      const createUrl = `${baseUrl}/groups?group_id=${encodeURIComponent(groupName)}`
      const createRes = await wazuhRequest(createUrl, { method: 'PUT', headers: auth })
      const alreadyExists = !createRes.ok && /already exist/i.test(createRes.body)
      if (!createRes.ok && !alreadyExists) {
        throw new Error(`PUT ${createUrl} → HTTP ${createRes.status}: ${createRes.body.slice(0, 300)}`)
      }
      previous.push({ groupName, created: createRes.ok, conf: priorConf })

      if (agentConf.trim()) {
        const confUrl = `${baseUrl}/groups/${encodeURIComponent(groupName)}/configuration`
        const confRes = await wazuhRequest(confUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/xml', ...auth },
          body: agentConf,
        })
        if (!confRes.ok) throw new Error(`PUT ${confUrl} → HTTP ${confRes.status}: ${confRes.body.slice(0, 300)}`)
      }

      applied.push(groupName)
    }

    return {
      success: true,
      message: `Applied ${applied.length} agent group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Agent-group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
