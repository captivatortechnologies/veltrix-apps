import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import { extensionRestoreBody } from './_shared'
import type { ExtensionRollbackEntry } from './deploy'

/**
 * Undo an extensions deploy from rollbackData.previousState (written by
 * deploy()), in reverse order:
 *   - an extension that was CREATED is deleted (DELETE /extensions/{id})
 *   - an extension that was UPDATED is restored (PUT) to its prior body
 * Applied over the PagerDuty REST API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ExtensionRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/extensions/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete extension "${entry.name}": ${pagerDutyErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const body = { extension: extensionRestoreBody(entry.prior) }
        const res = await client.request('PUT', `/extensions/${encodeURIComponent(entry.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to restore extension "${entry.name}": ${pagerDutyErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} extension(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
