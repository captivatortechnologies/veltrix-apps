import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { IntegrationRollbackEntry } from './deploy'

/**
 * Roll back integration settings using the state captured during deploy: each
 * integration's prior settings are PUT back in place (in reverse order).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back integration settings.' }
  }

  const previousState = (ctx.rollbackData as { previousState?: IntegrationRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      const res = await client.v1('PUT', `${client.v1OrgPath()}/integrations/${entry.integrationId}/settings`, {
        body: entry.prior,
      })
      if (!res.ok) {
        throw new Error(`Failed to restore integration "${entry.integrationType}": ${snykErrorMessage(res)}`)
      }
      reverted.push(entry.integrationType)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} integration(s): ${reverted.join(', ') || 'none'}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
