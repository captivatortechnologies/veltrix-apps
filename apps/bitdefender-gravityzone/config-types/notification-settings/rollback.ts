import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { configureNotificationsSettings } from '../../lib/gravityZoneApi'
import type { NotificationSettingsRollbackEntry } from './deploy'

/**
 * Roll back notification settings declarations using the state captured
 * during deploy: only entries this deploy actually CHANGED are restored (via
 * accounts.configureNotificationsSettings with the prior values for exactly
 * the fields that were touched); untouched declarations are left alone.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: NotificationSettingsRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (entry.changed && entry.prior) {
        await configureNotificationsSettings(client, { ...entry.prior, accountId: entry.accountId || undefined })
        reverted.push(entry.accountId || '(own account)')
      }
    }
    return {
      success: true,
      message: reverted.length
        ? `Rolled back ${reverted.length} notification settings declaration(s): ${reverted.join(', ')}`
        : 'No notification settings declarations required rollback (none were changed by this deploy).',
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.filter((p) => p.changed).length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
