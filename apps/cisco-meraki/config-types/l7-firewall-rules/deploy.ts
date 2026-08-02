import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, getL7FirewallRules, putL7FirewallRules } from '../../lib/merakiApi'
import { extractL7FirewallRuleSpecs, normalizeL7Rule, parseL7Rules, type MerakiL7FirewallRule } from './_shared'

/** Per-network rollback record: the L7 ruleset as it existed immediately before this deploy. */
export interface L7FirewallRollbackEntry {
  networkId: string
  rules: MerakiL7FirewallRule[]
}

/**
 * Deploy Meraki MX L7 (application-layer) firewall rules over the Dashboard
 * API. Same singleton-per-network shape as L3: every declared item is an
 * UPDATE (the resource always exists — even an empty ruleset is a valid live
 * state), never a create/delete.
 *
 *   read (rollback):  GET /networks/{networkId}/appliance/firewall/l7FirewallRules
 *   apply:            PUT /networks/{networkId}/appliance/firewall/l7FirewallRules
 *                      with { rules }
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractL7FirewallRuleSpecs(ctx.canvas).filter((s) => s.networkId)
  const previous: L7FirewallRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { rules: parsedRules, error } = parseL7Rules(spec.rulesRaw)
      if (error || !parsedRules) {
        throw new Error(`Network "${spec.networkId}": ${error ?? 'invalid rules'}`)
      }
      const normalized = parsedRules.map((r) => normalizeL7Rule(r))

      const prior = await getL7FirewallRules(client, spec.networkId)
      previous.push({ networkId: spec.networkId, rules: prior.rules })

      await putL7FirewallRules(client, spec.networkId, normalized)
      deployed.push(spec.networkId)
    }

    return {
      success: true,
      message: `Applied L7 firewall rules to ${deployed.length} network(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { baseUrl: 'https://api.meraki.com/api/v1', deployedNetworks: deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `L7 firewall rules deploy failed after ${deployed.length} of ${specs.length} network(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployedNetworks: deployed },
      rollbackData: { previous },
    }
  }
}
