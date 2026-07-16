import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient, cyberArkErrorMessage, encodeSafeUrlId } from '../../lib/cyberark'
import type { SafeRollbackEntry } from './deploy'

/**
 * Roll back safes using the state captured during deploy:
 *   - safes that were created are deleted (DELETE /Safes/{safeUrlId})
 *   - safes that were updated are restored (PUT) to their prior fields
 *
 * The prior snapshot comes from the GET /Safes summary (name, description,
 * retention, managingCPM, autoPurge). OLAC cannot be disabled once enabled, so it
 * is never sent on restore.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SafeRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.safeUrlId) {
          const res = await client.request('DELETE', `/Safes/${encodeSafeUrlId(entry.safeUrlId)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete safe "${entry.label}": ${cyberArkErrorMessage(res)}`)
          }
        }
      } else if (entry.safeUrlId && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          safeName: p.safeName ?? entry.label,
          description: p.description ?? '',
          autoPurgeEnabled: p.autoPurgeEnabled ?? false,
        }
        if (p.location) restore.location = p.location
        if (p.managingCPM) restore.managingCPM = p.managingCPM
        if (typeof p.numberOfDaysRetention === 'number') restore.numberOfDaysRetention = p.numberOfDaysRetention
        else if (typeof p.numberOfVersionsRetention === 'number') restore.numberOfVersionsRetention = p.numberOfVersionsRetention
        const res = await client.request('PUT', `/Safes/${encodeSafeUrlId(entry.safeUrlId)}`, { body: restore })
        if (!res.ok) throw new Error(`Failed to restore safe "${entry.label}": ${cyberArkErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    await client.logoff()
    return { success: true, message: `Rolled back ${reverted.length} safe(s): ${reverted.join(', ')}` }
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
