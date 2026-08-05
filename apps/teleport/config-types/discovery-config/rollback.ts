import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, teleportErrorMessage } from '../../lib/teleport'
import type { DiscoveryConfigRollbackEntry } from './deploy'

/**
 * Roll back DiscoveryConfigs using the state captured during deploy:
 *   - configs this deploy CREATED are deleted (DELETE .../discoveryconfig/{name}, tolerating a 404)
 *   - configs this deploy UPDATED are restored to their prior matchers (PUT .../discoveryconfig/{name})
 *
 * Deleting a created config stops the Discovery Service from enrolling resources through it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DiscoveryConfigRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    const site = await client.resolveSite()

    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.request(
          'DELETE',
          `/v1/webapi/sites/${encodeURIComponent(site)}/discoveryconfig/${encodeURIComponent(entry.name)}`,
        )
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete discovery config "${entry.name}": ${teleportErrorMessage(res)}`)
        }
      } else {
        const res = await client.request(
          'PUT',
          `/v1/webapi/sites/${encodeURIComponent(site)}/discoveryconfig/${encodeURIComponent(entry.name)}`,
          {
            body: {
              discoveryGroup: entry.priorDiscoveryGroup ?? '',
              aws: entry.priorAws ?? [],
              azureMatchers: entry.priorAzureMatchers ?? [],
              gcpMatchers: entry.priorGcpMatchers ?? [],
              kube: entry.priorKube ?? [],
            },
          },
        )
        if (!res.ok) throw new Error(`Failed to restore discovery config "${entry.name}": ${teleportErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} discovery config(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
