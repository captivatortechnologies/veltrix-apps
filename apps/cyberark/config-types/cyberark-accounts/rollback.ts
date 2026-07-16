import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient, cyberArkErrorMessage } from '../../lib/cyberark'
import type { AccountRollbackEntry } from './deploy'

/**
 * Roll back accounts using the state captured during deploy:
 *   - accounts that were created are deleted (DELETE /Accounts/{id})
 *   - accounts that were updated are restored (PATCH) to their prior non-secret
 *     fields.
 *
 * ⚠ SECRET LIMITATION: the account secret is write-only and never captured, so a
 * restored account keeps whatever secret it currently has. Only the address,
 * userName, secretManagement and platformAccountProperties are restored.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AccountRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/Accounts/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete account "${entry.label}": ${cyberArkErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const ops = buildRestoreOps(entry.prior)
        if (ops.length > 0) {
          const res = await client.request('PATCH', `/Accounts/${encodeURIComponent(entry.id)}`, { body: ops })
          if (!res.ok) throw new Error(`Failed to restore account "${entry.label}": ${cyberArkErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    await client.logoff()
    return { success: true, message: `Rolled back ${reverted.length} account(s): ${reverted.join(', ')}` }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** JSON-Patch ops that restore an updated account's prior non-secret fields. */
function buildRestoreOps(prior: NonNullable<AccountRollbackEntry['prior']>): Array<{ op: string; path: string; value: unknown }> {
  const ops: Array<{ op: string; path: string; value: unknown }> = []
  if (prior.address !== undefined) ops.push({ op: 'replace', path: '/address', value: prior.address })
  if (prior.userName !== undefined) ops.push({ op: 'replace', path: '/userName', value: prior.userName })
  if (prior.automaticManagementEnabled !== undefined) {
    ops.push({ op: 'replace', path: '/secretManagement/automaticManagementEnabled', value: prior.automaticManagementEnabled })
  }
  for (const [propKey, value] of Object.entries(prior.platformAccountProperties ?? {})) {
    ops.push({ op: 'add', path: `/platformAccountProperties/${propKey}`, value })
  }
  return ops
}
