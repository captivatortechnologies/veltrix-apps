import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, createGroupPolicy, listGroupPolicies, updateGroupPolicy } from '../../lib/merakiApi'
import { buildGroupPolicyBody, extractGroupPolicySpecs, groupPolicyKey, parseJsonObject, type MerakiGroupPolicy } from './_shared'

export interface GroupPolicyRollbackEntry {
  networkId: string
  name: string
  existed: boolean
  groupPolicyId?: string
  prior?: MerakiGroupPolicy
}

/**
 * Deploy Cisco Meraki group policies over the Dashboard API, reconciled by
 * NAME within each network:
 *   list:    GET  /networks/{networkId}/groupPolicies              → find by name
 *   update:  PUT  /networks/{networkId}/groupPolicies/{id}          when found
 *   create:  POST /networks/{networkId}/groupPolicies               when not found
 *
 * The live list is read once per distinct network and reused across every
 * item that targets it. rollbackData records, per item, whether the policy
 * existed and its prior full body — so rollback can restore an updated policy
 * or delete a newly created one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractGroupPolicySpecs(ctx.canvas).filter((s) => s.networkId && s.name)
  const previous: GroupPolicyRollbackEntry[] = []
  const deployed: string[] = []
  const liveByNetwork = new Map<string, MerakiGroupPolicy[]>()

  try {
    for (const spec of specs) {
      const { value: policy, error } = parseJsonObject(spec.policyRaw, 'policy')
      if (error || !policy) throw new Error(`Group policy "${spec.name}" in network "${spec.networkId}": ${error ?? 'invalid policy'}`)

      if (!liveByNetwork.has(spec.networkId)) {
        liveByNetwork.set(spec.networkId, await listGroupPolicies(client, spec.networkId))
      }
      const live = liveByNetwork.get(spec.networkId)!
      const match = live.find((p) => p.name && groupPolicyKey(p.name) === groupPolicyKey(spec.name))

      const body = buildGroupPolicyBody(spec.name, policy)
      const label = `${spec.networkId}/${spec.name}`

      if (match?.groupPolicyId) {
        previous.push({ networkId: spec.networkId, name: spec.name, existed: true, groupPolicyId: match.groupPolicyId, prior: match })
        await updateGroupPolicy(client, spec.networkId, match.groupPolicyId, body)
      } else {
        const created = await createGroupPolicy(client, spec.networkId, body)
        previous.push({ networkId: spec.networkId, name: spec.name, existed: false, groupPolicyId: created.groupPolicyId })
        // Keep the per-network cache in sync so a later item in this same run
        // that also targets this network sees the policy we just created.
        live.push(created)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} group polic${deployed.length === 1 ? 'y' : 'ies'}: ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Group policy deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
