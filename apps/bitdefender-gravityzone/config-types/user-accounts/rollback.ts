import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { deleteAccount, updateAccount, type GzAccount } from '../../lib/gravityZoneApi'
import { accountEmail, accountId, listAllAccounts, userAccountKey } from './_shared'
import type { UserAccountRollbackEntry } from './deploy'

/**
 * Roll back user accounts using the state captured during deploy:
 *   - accounts this deploy CREATED are deleted (accounts.deleteAccount)
 *   - accounts this deploy UPDATED are restored to their prior comparable
 *     fields (fullName/role/timezone/language/targetIds/rights)
 *   - unchanged accounts are left alone
 *
 * The password field CANNOT be restored — GravityZone never returns a
 * stored password, so a password reset by this config type stays in effect
 * after rollback. The rollback message says so explicitly when it applies.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: UserAccountRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  let passwordNote = false

  try {
    let liveByEmail: Map<string, GzAccount> | null = null
    for (const entry of [...previous].reverse()) {
      if (entry.action === 'created') {
        if (!liveByEmail) {
          const live = await listAllAccounts(client)
          liveByEmail = new Map(live.filter((a) => accountEmail(a)).map((a) => [userAccountKey(accountEmail(a)), a]))
        }
        const match = liveByEmail.get(userAccountKey(entry.email))
        if (match) await deleteAccount(client, accountId(match))
      } else if (entry.action === 'updated' && entry.prior) {
        if (!liveByEmail) {
          const live = await listAllAccounts(client)
          liveByEmail = new Map(live.filter((a) => accountEmail(a)).map((a) => [userAccountKey(accountEmail(a)), a]))
        }
        const match = liveByEmail.get(userAccountKey(entry.email))
        if (match) {
          await updateAccount(client, {
            accountId: accountId(match),
            fullName: entry.prior.fullName,
            role: entry.prior.role,
            timezone: entry.prior.timezone,
            language: entry.prior.language,
            targetIds: entry.prior.targetIds,
            rights: entry.prior.rights ?? undefined,
          })
          passwordNote = true
        }
      }
      reverted.push(entry.email)
    }

    return {
      success: true,
      message:
        `Rolled back ${reverted.length} user account(s): ${reverted.join(', ')}.` +
        (passwordNote ? ' Note: a password set by this config type cannot be restored — GravityZone never returns a stored password.' : ''),
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

