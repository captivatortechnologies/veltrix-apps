import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, listAffectedItems, sendJson } from '../../lib/wazuhApi'
import { specFromItem, toRuleBody } from './_shared'

/**
 * Deploy Wazuh RBAC rules over the REST API (55000):
 *   read (upsert + rollback): GET  ${base}/security/rules?limit=500
 *   create:                   POST ${base}/security/rules              { name, rule }
 *   update:                   PUT  ${base}/security/rules/{id}         { name, rule }
 *
 * NAME is the stable identity used to upsert. `comment` is audit-only and is
 * never sent to the manager. `rule` is sent in full each deploy (declarative
 * full-replace of the condition tree).
 *
 * rollbackData.previous records, per rule, whether we created it (`created`)
 * and its PRIOR `rule` body (null for a freshly created one).
 */
interface WazuhRbacRule {
  id: number
  name: string
  rule: Record<string, unknown>
}

export interface RollbackEntry {
  name: string
  id: number | null
  created: boolean
  priorRule: Record<string, unknown> | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for RBAC-rule deployment' }
  }

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    const existing = await listAffectedItems<WazuhRbacRule>(baseUrl, auth, '/security/rules')
    const byName = new Map(existing.map((r) => [r.name, r]))

    for (const item of items) {
      const spec = specFromItem(item)
      if (!spec.name || !spec.rule) continue
      const body = toRuleBody(spec)

      const found = byName.get(spec.name)
      if (found) {
        await sendJson('PUT', `${baseUrl}/security/rules/${found.id}`, auth, body)
        previous.push({ name: spec.name, id: found.id, created: false, priorRule: found.rule })
      } else {
        const created = await sendJson<{ data?: { affected_items?: WazuhRbacRule[] } }>('POST', `${baseUrl}/security/rules`, auth, body)
        previous.push({ name: spec.name, id: created.data?.affected_items?.[0]?.id ?? null, created: true, priorRule: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} RBAC rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `RBAC-rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
