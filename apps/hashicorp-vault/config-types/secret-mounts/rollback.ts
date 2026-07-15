import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { MountRollbackEntry } from './deploy'

/**
 * Roll back secret engine mounts using the state captured during deploy:
 *   - mounts this deploy ENABLED are disabled (DELETE /sys/mounts/{path})
 *   - mounts this deploy TUNED are restored to their prior tuning (POST .../tune)
 *
 * Disabling a mount is DESTRUCTIVE: it revokes every secret associated with the
 * mount, i.e. it permanently deletes all data stored under that path. Rollback
 * therefore only ever disables mounts that DEPLOY ITSELF CREATED (existed:false)
 * — never a pre-existing one — and the result message says plainly that the data
 * under those newly-created mounts was destroyed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: MountRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const destroyed: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy ENABLED this mount — disabling it removes the engine AND
        // permanently destroys every secret written under it. 404 means it is
        // already gone, which is the desired end state.
        const res = await client.request('DELETE', `/sys/mounts/${entry.path}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to disable secret engine "${entry.path}": ${vaultErrorMessage(res)}`)
        }
        destroyed.push(entry.path)
      } else if (entry.priorTune) {
        // Deploy TUNED this mount — restore the captured prior tuning.
        const body: Record<string, unknown> = {}
        if (entry.priorTune.default_lease_ttl !== undefined) body.default_lease_ttl = entry.priorTune.default_lease_ttl
        if (entry.priorTune.max_lease_ttl !== undefined) body.max_lease_ttl = entry.priorTune.max_lease_ttl
        if (entry.priorTune.description !== undefined) body.description = entry.priorTune.description

        const res = await client.request('POST', `/sys/mounts/${entry.path}/tune`, { body })
        if (!res.ok) {
          throw new Error(`Failed to restore tuning for secret engine "${entry.path}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(entry.path)
    }

    const destroyNote = destroyed.length
      ? ` WARNING: disabled ${destroyed.length} newly-created mount(s) (${destroyed.join(', ')}) — this is DESTRUCTIVE and PERMANENTLY DESTROYED all secrets and data stored under them.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} secret engine(s): ${reverted.join(', ')}.${destroyNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} mount(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
