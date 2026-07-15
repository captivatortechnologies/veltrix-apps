import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { SandboxRuleRollbackEntry } from './deploy'

/**
 * Roll back ZIA sandbox rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /sandboxRules/{id})
 *   - rules that were updated are restored (PUT) to their full prior body
 * The prior object is PUT back verbatim so the rule_json escape-hatch criteria
 * (Sandbox action, policy categories, file types, …) are faithfully restored,
 * not just the managed scalars. Reverting is itself a staged change, so this
 * activates once at the end. The protected default rule is never captured for
 * rollback (deploy refuses to touch it), so it is never affected here.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SandboxRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/sandboxRules/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete sandbox rule "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const res = await client.zia('PUT', `/sandboxRules/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore sandbox rule "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} sandbox rule(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA sandbox rule(s): ${reverted.join(', ')}`,
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
