import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, listAffectedItems, sendJson } from '../../lib/wazuhApi'
import { specFromItem, toPolicyBody } from './_shared'

/**
 * Deploy Wazuh API policies over the REST API (55000):
 *   read (upsert + rollback): GET  ${base}/security/policies?limit=500
 *   create:                   POST ${base}/security/policies              { name, policy }
 *   update:                   PUT  ${base}/security/policies/{id}         { name, policy }
 *
 * NAME is the stable identity used to upsert — Wazuh's own id is internal.
 * `comment` is audit-only and is never sent to the manager. `policy` is sent
 * in full each deploy (declarative full-replace of actions/resources/effect,
 * same content-replace philosophy as the CDB-lists/custom-rules file types).
 *
 * rollbackData.previous records, per policy, whether we created it (`created`)
 * and its PRIOR `policy` body (null for a freshly created one) so rollback can
 * DELETE what we created or PUT the prior definition back.
 */
interface WazuhPolicy {
  id: number
  name: string
  policy: { actions: string[]; resources: string[]; effect: string }
}

export interface RollbackEntry {
  name: string
  id: number | null
  created: boolean
  priorPolicy: { actions: string[]; resources: string[]; effect: string } | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for API-policy deployment' }
  }

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    const existing = await listAffectedItems<WazuhPolicy>(baseUrl, auth, '/security/policies')
    const byName = new Map(existing.map((p) => [p.name, p]))

    for (const item of items) {
      const spec = specFromItem(item)
      if (!spec.name) continue
      const body = toPolicyBody(spec)

      const found = byName.get(spec.name)
      if (found) {
        await sendJson('PUT', `${baseUrl}/security/policies/${found.id}`, auth, body)
        previous.push({ name: spec.name, id: found.id, created: false, priorPolicy: found.policy })
      } else {
        const created = await sendJson<{ data?: { affected_items?: WazuhPolicy[] } }>('POST', `${baseUrl}/security/policies`, auth, body)
        previous.push({ name: spec.name, id: created.data?.affected_items?.[0]?.id ?? null, created: true, priorPolicy: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} API polic${applied.length === 1 ? 'y' : 'ies'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `API-policy deploy failed after ${applied.length} polic${applied.length === 1 ? 'y' : 'ies'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
