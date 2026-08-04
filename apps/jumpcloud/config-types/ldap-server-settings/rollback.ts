import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage } from '../../lib/jumpcloudApi'
import type { LdapServerSettingsRollbackEntry } from './deploy'

/**
 * Undo an LDAP Server Settings deploy from rollbackData.previousState (written
 * by deploy): PATCH each server back to its prior managed fields (name / lockout
 * action / password-expiration action). There is never a "created" case to
 * delete — this config type can only update an existing server.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousState = (ctx.rollbackData as { previousState?: LdapServerSettingsRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const reverted: string[] = []
  try {
    for (const entry of previousState) {
      const res = await client.request('PATCH', `/ldapservers/${encodeURIComponent(entry.id)}`, { body: entry.prior })
      if (!res.ok) throw new Error(`Failed to restore LDAP server "${entry.name}": ${jumpCloudErrorMessage(res)}`)
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back settings on ${reverted.length} LDAP server(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} server(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
