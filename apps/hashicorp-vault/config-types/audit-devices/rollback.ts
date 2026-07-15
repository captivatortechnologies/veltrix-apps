import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { AuditDeviceRollbackEntry } from './deploy'

/**
 * Roll back audit devices using the state captured during deploy:
 *   - devices this deploy CREATED are disabled (DELETE /sys/audit/{path}),
 *     tolerating a 404 (already gone).
 *   - devices this deploy RE-ENABLED are restored to their ORIGINAL config. With
 *     no tune endpoint, restoring is itself a disable + re-enable (DELETE the
 *     current device, then PUT the captured prior body) — so, like deploy, there
 *     is a brief window with no audit logging at that path.
 *
 * Rollback keys on the stable path. Disabling a device stops audit logging at
 * that path; if it was the only audit device, Vault may refuse requests until an
 * audit device is restored — the message says so.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AuditDeviceRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy enabled this device — disable it. 404 means it is already gone
        // (or was never enabled), which is the desired end state.
        const res = await client.request('DELETE', `/sys/audit/${entry.path}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to disable audit device "${entry.path}": ${vaultErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        // Deploy re-enabled this device with new config — restore the original.
        // No tune endpoint, so this is a disable + re-enable of the prior body.
        const del = await client.request('DELETE', `/sys/audit/${entry.path}`)
        if (del.status !== 404 && !del.ok) {
          throw new Error(
            `Failed to disable audit device "${entry.path}" before restoring it: ${vaultErrorMessage(del)}`,
          )
        }

        const restoreBody: Record<string, unknown> = {
          type: entry.prior.type,
          options: entry.prior.options,
        }
        if (entry.prior.description) restoreBody.description = entry.prior.description

        const put = await client.request('PUT', `/sys/audit/${entry.path}`, { body: restoreBody })
        if (!put.ok) {
          throw new Error(
            `Audit device "${entry.path}" was disabled but its prior config could NOT be restored: ${vaultErrorMessage(put)}.`,
          )
        }
      }

      reverted.push(entry.path)
    }

    return {
      success: true,
      message:
        `Rolled back ${reverted.length} audit device(s): ${reverted.join(', ')}. ` +
        'Note: disabling an audit device stops audit logging at that path, and each restore briefly re-enables ' +
        '(disable → re-enable); if a path was the only audit device, Vault may refuse requests while no device is present.',
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} device(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
