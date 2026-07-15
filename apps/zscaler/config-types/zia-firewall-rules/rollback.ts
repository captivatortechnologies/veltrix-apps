import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import { isProtectedRule, type FirewallRuleRollbackEntry } from './deploy'

/**
 * Roll back ZIA firewall filtering rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /firewallFilteringRules/{id})
 *   - rules that were updated are restored (PUT) to their prior body
 * Reverting is itself a staged change, so this activates once at the end.
 *
 * The predefined default rule is never created and never modified by deploy, so
 * it never appears in the rollback state — but as a defensive guard this refuses
 * to delete any entry that looks predefined.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: FirewallRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/firewallFilteringRules/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete firewall rule "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        // Never restore-over (or delete) a predefined rule.
        if (isProtectedRule(entry.prior)) {
          reverted.push(entry.name)
          continue
        }
        const res = await client.zia('PUT', `/firewallFilteringRules/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore firewall rule "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} firewall rule(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA firewall rule(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
