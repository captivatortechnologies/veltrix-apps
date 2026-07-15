import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { AppConnectorGroupRollbackEntry } from './deploy'

/**
 * Roll back ZPA App Connector groups using the state captured during deploy:
 *   - groups that were created are deleted (DELETE /appConnectorGroup/{id})
 *   - groups that were updated are restored (PUT) to their prior body
 * ZPA changes are immediate, so no activation is needed. Deleting an App
 * Connector group still referenced by a server group will fail — reverse-order
 * and the pipeline's dependency ordering keep referrers gone first.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AppConnectorGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zpa('DELETE', `/appConnectorGroup/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete App Connector group "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const prior = entry.prior
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: prior.name ?? entry.name,
          description: prior.description ?? '',
          enabled: prior.enabled ?? true,
          location: prior.location ?? '',
          latitude: prior.latitude ?? '',
          longitude: prior.longitude ?? '',
          countryCode: prior.countryCode ?? '',
          dnsQueryType: prior.dnsQueryType ?? 'IPV4_IPV6',
          versionProfileId: prior.versionProfileId ?? '0',
          cityCountry: prior.cityCountry ?? '',
        }
        const res = await client.zpa('PUT', `/appConnectorGroup/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore App Connector group "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} ZPA App Connector group(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
