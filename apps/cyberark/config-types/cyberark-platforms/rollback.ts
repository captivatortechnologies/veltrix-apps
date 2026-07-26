import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient, cyberArkErrorMessage } from '../../lib/cyberark'
import type { PlatformRollbackEntry } from './deploy'

/**
 * Roll back platforms using the state captured during deploy:
 *   - platforms that were imported (created) are deleted (DELETE
 *     /Platforms/Targets/{id})
 *   - platforms that were updated have their prior active state restored
 *     (activate / deactivate).
 *
 * ⚠ The write-only import package is never captured, so a deleted platform cannot
 * be re-imported by rollback — the import is treated as the created resource and
 * simply removed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PlatformRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id !== undefined) {
          const res = await client.request('DELETE', `/Platforms/Targets/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete platform "${entry.label}": ${cyberArkErrorMessage(res)}`)
          }
        }
      } else if (entry.id !== undefined && entry.priorActive !== undefined) {
        const action = entry.priorActive ? 'activate' : 'deactivate'
        const res = await client.request('POST', `/Platforms/Targets/${entry.id}/${action}/`)
        if (!res.ok) throw new Error(`Failed to restore platform "${entry.label}": ${cyberArkErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    await client.logoff()
    return { success: true, message: `Rolled back ${reverted.length} platform(s): ${reverted.join(', ')}` }
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
