import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { WebhookRollbackEntry } from './deploy'

/**
 * Roll back webhooks using the state captured during deploy: webhooks this
 * deploy created are deleted; webhooks that already existed are left alone
 * (they were never modified).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back webhooks.' }
  }

  const previousState = (ctx.rollbackData as { previousState?: WebhookRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed && entry.createdId) {
        const res = await client.v1('DELETE', `${client.v1OrgPath()}/webhooks/${entry.createdId}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete webhook "${entry.url}": ${snykErrorMessage(res)}`)
        }
        reverted.push(entry.url)
      }
    }

    return { success: true, message: `Rolled back ${reverted.length} created webhook(s): ${reverted.join(', ') || 'none'}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
