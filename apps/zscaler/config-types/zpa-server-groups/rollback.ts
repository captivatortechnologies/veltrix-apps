import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { ServerGroupRollbackEntry } from './deploy'

/**
 * Roll back ZPA server groups using the state captured during deploy:
 *   - groups that were created are deleted (DELETE /serverGroup/{id})
 *   - groups that were updated are restored (PUT) to their prior body
 * ZPA changes are immediate, so no activation is needed. Deleting a server group
 * still referenced by an application segment will fail — reverse-order and the
 * pipeline's dependency ordering keep referrers gone first.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ServerGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zpa('DELETE', `/serverGroup/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete server group "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: entry.prior.name ?? entry.name,
          description: entry.prior.description ?? '',
          enabled: entry.prior.enabled ?? true,
          dynamicDiscovery: entry.prior.dynamicDiscovery ?? true,
          appConnectorGroups: (entry.prior.appConnectorGroups ?? []).map((g) => ({ id: g.id })),
        }
        // Explicit servers only apply (and only round-trip) with discovery off.
        if (entry.prior.dynamicDiscovery === false) {
          restore.servers = (entry.prior.servers ?? []).map((s) => ({ id: s.id }))
        }
        const res = await client.zpa('PUT', `/serverGroup/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore server group "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} ZPA server group(s): ${reverted.join(', ')}`,
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
