import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, listAffectedItems, sendJson, wazuhRequest } from '../../lib/wazuhApi'
import { specFromItem, diffIdSets, resolveNamesToIds } from './_shared'

/**
 * Deploy Wazuh API roles over the REST API (55000):
 *   read (upsert + rollback): GET    ${base}/security/roles?limit=500     (id, name, policies[], rules[])
 *   read (resolve names):     GET    ${base}/security/policies?limit=500  GET ${base}/security/rules?limit=500
 *   create:                   POST   ${base}/security/roles               { name }
 *   attach policies:          POST   ${base}/security/roles/{id}/policies?policy_ids=1,2,3
 *   detach policies:          DELETE ${base}/security/roles/{id}/policies?policy_ids=1,2,3
 *   attach rules:             POST   ${base}/security/roles/{id}/rules?rule_ids=1,2
 *   detach rules:             DELETE ${base}/security/roles/{id}/rules?rule_ids=1,2
 *
 * NAME is the stable identity used to upsert the role itself. `policies`/`rules`
 * are declared as the role's COMPLETE set (by NAME, resolved to ids here) —
 * each deploy reconciles the live relationship to match exactly (adds what's
 * missing, detaches what's no longer declared), the same declarative
 * full-replace philosophy as the other config types' file bodies. An
 * unresolvable policy/rule name fails that item's deploy with the full list of
 * missing names. `comment` is audit-only and is never sent to the manager.
 *
 * NOTE: attachment order reflects call order, not necessarily the declared list
 * order — Wazuh's policy-priority `position` parameter is not managed here (see
 * README "Known limitations").
 *
 * rollbackData.previous records, per role, whether we created it (`created`)
 * and its PRIOR policy/rule id sets (empty arrays for a freshly created role)
 * so rollback can DELETE what we created or restore the exact prior sets.
 */
interface WazuhRole {
  id: number
  name: string
  policies: number[]
  rules: number[]
}
interface WazuhNamedResource {
  id: number
  name: string
}

export interface RollbackEntry {
  name: string
  id: number | null
  created: boolean
  priorPolicyIds: number[]
  priorRuleIds: number[]
}

async function applyRelationshipDiff(
  baseUrl: string,
  auth: Record<string, string>,
  path: string,
  idParam: string,
  toAdd: number[],
  toRemove: number[],
): Promise<void> {
  if (toAdd.length) {
    const url = `${baseUrl}${path}?${idParam}=${toAdd.join(',')}`
    const res = await wazuhRequest(url, { method: 'POST', headers: auth })
    if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }
  if (toRemove.length) {
    const url = `${baseUrl}${path}?${idParam}=${toRemove.join(',')}`
    const res = await wazuhRequest(url, { method: 'DELETE', headers: auth })
    if (!res.ok) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for API-role deployment' }
  }

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    const existingRoles = await listAffectedItems<WazuhRole>(baseUrl, auth, '/security/roles')
    const rolesByName = new Map(existingRoles.map((r) => [r.name, r]))
    const policiesByName = new Map(
      (await listAffectedItems<WazuhNamedResource>(baseUrl, auth, '/security/policies')).map((p) => [p.name, p.id]),
    )
    const rulesByName = new Map(
      (await listAffectedItems<WazuhNamedResource>(baseUrl, auth, '/security/rules')).map((r) => [r.name, r.id]),
    )

    for (const item of items) {
      const spec = specFromItem(item)
      if (!spec.name) continue

      const desiredPolicyIds = resolveNamesToIds(spec.policyNames, policiesByName, 'Policy')
      const desiredRuleIds = resolveNamesToIds(spec.ruleNames, rulesByName, 'RBAC rule')

      let role = rolesByName.get(spec.name)
      let created = false
      let priorPolicyIds: number[] = []
      let priorRuleIds: number[] = []

      if (!role) {
        const createdRes = await sendJson<{ data?: { affected_items?: WazuhRole[] } }>('POST', `${baseUrl}/security/roles`, auth, { name: spec.name })
        const newRole = createdRes.data?.affected_items?.[0]
        if (!newRole) throw new Error(`Role "${spec.name}" was not returned after creation`)
        role = newRole
        created = true
      } else {
        priorPolicyIds = role.policies
        priorRuleIds = role.rules
      }

      const policyDiff = diffIdSets(priorPolicyIds, desiredPolicyIds)
      await applyRelationshipDiff(baseUrl, auth, `/security/roles/${role.id}/policies`, 'policy_ids', policyDiff.toAdd, policyDiff.toRemove)

      const ruleDiff = diffIdSets(priorRuleIds, desiredRuleIds)
      await applyRelationshipDiff(baseUrl, auth, `/security/roles/${role.id}/rules`, 'rule_ids', ruleDiff.toAdd, ruleDiff.toRemove)

      previous.push({ name: spec.name, id: role.id, created, priorPolicyIds, priorRuleIds })
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} API role(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `API-role deploy failed after ${applied.length} role(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
