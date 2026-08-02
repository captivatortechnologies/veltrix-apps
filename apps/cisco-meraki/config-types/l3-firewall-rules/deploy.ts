import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, getL3FirewallRules, putL3FirewallRules } from '../../lib/merakiApi'
import { buildRulesBody, extractL3FirewallRuleSpecs, normalizeRule, parseRules, type MerakiL3FirewallRule } from './_shared'

/** Per-network rollback record: the ruleset as it existed immediately before this deploy. */
export interface L3FirewallRollbackEntry {
  networkId: string
  rules: MerakiL3FirewallRule[]
}

/**
 * Deploy Meraki MX L3 (outbound) firewall rules over the Dashboard API.
 *
 * L3 Firewall Rules is a SINGLETON per network — Meraki always has exactly one
 * ruleset per network (there is no create/delete of the resource itself, only
 * a whole-list replace), so every declared item is an UPDATE:
 *
 *   read (rollback):  GET /networks/{networkId}/appliance/firewall/l3FirewallRules
 *   apply:            PUT /networks/{networkId}/appliance/firewall/l3FirewallRules
 *                      with { rules, syslogDefaultRule }
 *
 * `rollbackData.previous` captures, per network, the exact ordered ruleset that
 * was live immediately before this deploy overwrote it — rollback restores it
 * verbatim. `syslogDefaultRule` is declared on every deploy but is DELIBERATELY
 * NOT captured for rollback: Meraki never echoes its current value back on GET
 * or PUT, so there is nothing to restore it to (see rollback.ts).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractL3FirewallRuleSpecs(ctx.canvas).filter((s) => s.networkId)
  const previous: L3FirewallRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { rules: parsedRules, error } = parseRules(spec.rulesRaw)
      if (error || !parsedRules) {
        throw new Error(`Network "${spec.networkId}": ${error ?? 'invalid rules'}`)
      }
      const normalized = parsedRules.map((r) => normalizeRule(r))

      const prior = await getL3FirewallRules(client, spec.networkId)
      previous.push({ networkId: spec.networkId, rules: prior.rules })

      const body = buildRulesBody(normalized, spec.syslogDefaultRule)
      await putL3FirewallRules(client, spec.networkId, body)
      deployed.push(spec.networkId)
    }

    return {
      success: true,
      message: `Applied L3 firewall rules to ${deployed.length} network(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { baseUrl: 'https://api.meraki.com/api/v1', deployedNetworks: deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `L3 firewall rules deploy failed after ${deployed.length} of ${specs.length} network(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployedNetworks: deployed },
      rollbackData: { previous },
    }
  }
}
