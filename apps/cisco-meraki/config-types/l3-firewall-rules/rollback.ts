import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, putL3FirewallRules } from '../../lib/merakiApi'
import { buildRulesBody } from './_shared'
import type { L3FirewallRollbackEntry } from './deploy'

/**
 * Roll back L3 firewall rules using the state captured during deploy: restore
 * each network's exact ordered ruleset via PUT
 * /networks/{networkId}/appliance/firewall/l3FirewallRules with
 * `{ rules: entry.rules }`.
 *
 * `syslogDefaultRule` is DELIBERATELY OMITTED from the restore body. Meraki
 * never returns the current value of that flag on GET or PUT — the deploy that
 * ran before this rollback declared a value, but there is no prior value on
 * record to restore it to. Omitting the key is the safest choice available:
 * whatever Meraki does with an absent optional field on this endpoint is
 * unverified, but guessing a value would risk silently toggling syslog behavior
 * the rollback was never told to touch. The next deploy re-declares it either
 * way.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: L3FirewallRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const restored: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.networkId) continue
      await putL3FirewallRules(client, entry.networkId, buildRulesBody(entry.rules ?? []))
      restored.push(entry.networkId)
    }
    return { success: true, message: `Rolled back L3 firewall rules on ${restored.length} network(s): ${restored.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${restored.length} of ${previous.length} network(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
