import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import { REGISTRY_ENTITY, type RegistryRollbackEntry } from './deploy'

/**
 * Roll back registry connections using the state captured during deploy:
 *   - registries that were created are deleted (DELETE …?ids=<id>)
 *   - registries that were updated are patched back to their prior NON-SECRET
 *     fields (type, url, uniqueness key, alias, state, scan interval)
 *
 * ⚠ The credential is never restored — it was never read back or stored, so a
 * rolled-back registry keeps whatever credential the deployment set. Rotate it
 * through the Falcon console if needed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RegistryRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this registry — remove it. 404 means it never finished
        // creating or is already gone, which is the desired state.
        if (entry.id) {
          const res = await client.request(
            'DELETE',
            `${REGISTRY_ENTITY}?ids=${encodeURIComponent(entry.id)}`,
          )
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(`Failed to delete registry "${entry.name}": ${deleteFailure}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this registry — restore the captured non-secret values.
        const restore: Record<string, unknown> = {}
        if (entry.prior.type !== undefined) restore.type = entry.prior.type
        if (entry.prior.url !== undefined) restore.url = entry.prior.url
        if (entry.prior.url_uniqueness_key !== undefined) {
          restore.url_uniqueness_key = entry.prior.url_uniqueness_key
        }
        if (entry.prior.user_defined_alias !== undefined) {
          restore.user_defined_alias = entry.prior.user_defined_alias
        }
        if (entry.prior.state !== undefined) restore.state = entry.prior.state
        if (entry.prior.scan_interval !== undefined) restore.scan_interval = entry.prior.scan_interval

        const res = await client.request('PATCH', `${REGISTRY_ENTITY}?id=${encodeURIComponent(entry.id)}`, {
          body: restore,
        })
        const restoreFailure = falconFailure(res)
        if (restoreFailure) {
          throw new Error(`Failed to restore registry "${entry.name}": ${restoreFailure}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} registry connection(s): ${reverted.join(', ')}. Credentials are not restored by rollback — rotate in the Falcon console if needed.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} registry(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
