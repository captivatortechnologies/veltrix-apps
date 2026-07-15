import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { AuthMethodRollbackEntry } from './deploy'
import type { LiveAuthTune } from './validate'

/**
 * Roll back auth methods using the state captured during deploy:
 *   - methods this deploy ENABLED are disabled (DELETE /sys/auth/{path})
 *   - methods this deploy TUNED are restored to their prior tuning (tune again)
 *
 * Rollback keys on the stable path. Disabling an auth method is DESTRUCTIVE — it
 * revokes every lease and token issued under that mount — so the message calls
 * out any mount that was disabled.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AuthMethodRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const disabled: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy enabled this method — disable it. 404 means it is already gone
        // (or was never enabled), which is the desired end state. DESTRUCTIVE.
        const res = await client.request('DELETE', `/sys/auth/${entry.path}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to disable auth method "${entry.path}": ${vaultErrorMessage(res)}`)
        }
        disabled.push(entry.path)
      } else if (entry.priorTune) {
        // Deploy tuned this method — restore the captured prior tuning.
        const res = await client.request('POST', `/sys/auth/${entry.path}/tune`, {
          body: buildRestoreTuneBody(entry.priorTune),
        })
        if (!res.ok) {
          throw new Error(`Failed to restore tuning for auth method "${entry.path}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(entry.path)
    }

    const note =
      disabled.length > 0
        ? ` Note: disabling auth method(s) ${disabled.join(', ')} is DESTRUCTIVE — it revokes every lease and token issued under them.`
        : ''

    return {
      success: true,
      message: `Rolled back ${reverted.length} auth method(s): ${reverted.join(', ')}.${note}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} auth method(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Restore prior tuning; TTLs come back from Vault as seconds numbers — echo them as-is. */
function buildRestoreTuneBody(tune: LiveAuthTune): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (tune.default_lease_ttl !== undefined) body.default_lease_ttl = tune.default_lease_ttl
  if (tune.max_lease_ttl !== undefined) body.max_lease_ttl = tune.max_lease_ttl
  if (tune.description !== undefined) body.description = tune.description
  if (tune.token_type !== undefined) body.token_type = tune.token_type
  if (tune.listing_visibility !== undefined) body.listing_visibility = tune.listing_visibility
  return body
}
