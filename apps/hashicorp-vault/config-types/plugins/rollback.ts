import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import { pluginKey } from './validate'
import type { PluginRollbackEntry } from './deploy'

/**
 * Roll back plugin catalog changes using the state captured during deploy:
 *   - plugins this deploy REGISTERED are deregistered (DELETE the catalog entry)
 *   - plugins this deploy UPDATED are re-registered with their prior metadata
 *
 * Rollback keys on the stable (type, name) identity. Two caveats are surfaced in
 * the result message:
 *   - Deregistering a plugin that a secret/auth/database MOUNT still uses BREAKS
 *     that mount (the mount can no longer load its backend). Rollback only ever
 *     deregisters plugins DEPLOY ITSELF REGISTERED, never a pre-existing one.
 *   - A restore cannot reinstate a prior `env`: Vault never returns env on read,
 *     so it was never captured. Any env set out-of-band before the update is lost.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PluginRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const deregistered: string[] = []
  let restoredWithoutEnv = false

  try {
    for (const entry of previousState) {
      const key = pluginKey(entry.type, entry.name)

      if (!entry.existed) {
        // Deploy registered this plugin — deregister it. 404 means it is already
        // gone, which is the desired end state.
        const res = await client.request('DELETE', `/sys/plugins/catalog/${entry.type}/${entry.name}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to deregister plugin "${key}": ${vaultErrorMessage(res)}`)
        }
        deregistered.push(key)
      } else if (entry.prior) {
        // Deploy updated this plugin — re-register its prior metadata. env cannot
        // be restored (never captured), so the restore body omits it.
        const res = await client.request('POST', `/sys/plugins/catalog/${entry.type}/${entry.name}`, {
          body: buildRestoreBody(entry.prior),
        })
        if (!res.ok) {
          throw new Error(`Failed to restore plugin "${key}": ${vaultErrorMessage(res)}`)
        }
        restoredWithoutEnv = true
      }

      reverted.push(key)
    }

    const deregisterNote =
      deregistered.length > 0
        ? ` Note: deregistering plugin(s) ${deregistered.join(', ')} BREAKS any secret/auth/database mount still using them — the mount can no longer load its backend.`
        : ''
    const envNote = restoredWithoutEnv
      ? ' Note: a restored plugin\'s prior env could NOT be reinstated — Vault never returns env on read, so it was never captured.'
      : ''

    return {
      success: true,
      message: `Rolled back ${reverted.length} plugin(s): ${reverted.join(', ')}.${deregisterNote}${envNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} plugin(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Re-register a plugin from its captured prior metadata (env is not restorable). */
function buildRestoreBody(prior: NonNullable<PluginRollbackEntry['prior']>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (prior.sha256 !== undefined) body.sha256 = prior.sha256
  if (prior.command !== undefined) body.command = prior.command
  if (prior.args !== undefined) body.args = prior.args
  if (prior.version !== undefined) body.version = prior.version
  return body
}
