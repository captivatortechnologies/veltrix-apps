import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, putL7FirewallRules } from '../../lib/merakiApi'
import type { L7FirewallRollbackEntry } from './deploy'

/**
 * Roll back L7 firewall rules using the state captured during deploy: restore
 * each network's exact ordered ruleset via PUT
 * /networks/{networkId}/appliance/firewall/l7FirewallRules with `{ rules }`.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: L7FirewallRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const restored: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.networkId) continue
      await putL7FirewallRules(client, entry.networkId, entry.rules ?? [])
      restored.push(entry.networkId)
    }
    return { success: true, message: `Rolled back L7 firewall rules on ${restored.length} network(s): ${restored.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${restored.length} of ${previous.length} network(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
