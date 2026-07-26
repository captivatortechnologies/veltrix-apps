import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import { OPERATOR, TARGET } from './validate'
import type { PageRuleRollbackEntry } from './deploy'

/**
 * Roll back Page Rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /pagerules/{id})
 *   - rules that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PageRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.zone('DELETE', `/pagerules/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete Page Rule "${entry.label}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          targets: p.targets ?? [{ target: TARGET, constraint: { operator: OPERATOR, value: entry.label } }],
          actions: p.actions ?? [],
          priority: p.priority ?? 1,
          status: p.status ?? 'active',
        }
        const res = await client.zone('PUT', `/pagerules/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore Page Rule "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} Page Rule(s): ${reverted.join(', ')}`,
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
