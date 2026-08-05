import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { USER_PATH, userWriteError, type UserRollbackEntry } from './deploy'

/**
 * Roll back user accounts using the state captured during deploy:
 *   - users that were updated are best-effort restored (action=edit) to their
 *     prior first/last name and job title — email/address/role/business unit
 *     are not part of the live-listable shape this app reads back, so those
 *     are not restored.
 *   - users that were CREATED cannot be deleted — the classic v2 API has no
 *     delete-user endpoint (only Activate/Deactivate). This app instead
 *     best-effort DEACTIVATES a created user (action=deactivate). Note a
 *     freshly invited user (the default `send_email=1` flow) stays in
 *     "Pending Activation" status until they first log in, and Qualys refuses
 *     to activate/deactivate an account in that status — deactivation only
 *     succeeds once the account has actually gone Active. Either way this is
 *     reported, never treated as a rollback failure.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: UserRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const restored: string[] = []
  const deactivated: string[] = []
  const notDeactivated: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (!entry.login) {
          notDeactivated.push(entry.label)
          continue
        }
        const res = await client.post(USER_PATH, { action: 'deactivate', login: entry.login })
        if (userWriteError(res)) notDeactivated.push(entry.label)
        else deactivated.push(entry.label)
        continue
      }
      if (entry.login && entry.prior) {
        const res = await client.post(USER_PATH, {
          action: 'edit',
          login: entry.login,
          first_name: entry.prior.firstName,
          last_name: entry.prior.lastName,
          title: entry.prior.jobTitle,
        })
        const failed = userWriteError(res)
        if (failed) throw new Error(`Failed to restore user "${entry.label}": ${failed}`)
        restored.push(entry.label)
      }
    }

    const parts: string[] = []
    if (restored.length > 0) parts.push(`restored ${restored.length} user(s): ${restored.join(', ')}`)
    if (deactivated.length > 0) parts.push(`deactivated ${deactivated.length} created user(s): ${deactivated.join(', ')}`)
    if (notDeactivated.length > 0) {
      parts.push(
        `${notDeactivated.length} created user(s) could NOT be deactivated (no delete-user API exists, and a Pending Activation account cannot be deactivated) and remain: ${notDeactivated.join(', ')}`,
      )
    }
    return { success: true, message: parts.length > 0 ? parts.join('; ') : 'Nothing to roll back' }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after restoring ${restored.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
