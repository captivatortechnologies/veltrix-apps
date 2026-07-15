import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import { GATEWAY_RULES_PATH } from './validate'
import type { GatewayPolicyRollbackEntry } from './deploy'

/**
 * Roll back Gateway policies using the state captured during deploy:
 *   - policies that were created are deleted (DELETE /gateway/rules/{id})
 *   - policies that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: GatewayPolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.account('DELETE', `${GATEWAY_RULES_PATH}/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete gateway policy "${entry.label}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          name: p.name,
          action: p.action,
          enabled: p.enabled ?? true,
          filters: p.filters ?? [],
          traffic: p.traffic ?? '',
        }
        if (p.precedence !== undefined) restore.precedence = p.precedence
        if (p.identity !== undefined) restore.identity = p.identity
        if (p.device_posture !== undefined) restore.device_posture = p.device_posture
        if (p.rule_settings !== undefined) restore.rule_settings = p.rule_settings
        const res = await client.account('PUT', `${GATEWAY_RULES_PATH}/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore gateway policy "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} gateway policy(ies): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
