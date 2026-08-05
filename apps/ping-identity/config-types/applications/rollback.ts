import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import type { ApplicationRollbackEntry } from './deploy'

/**
 * Roll back applications using the state captured during deploy:
 *   - applications this deploy CREATED are deleted. A 404 means the
 *     application is already gone, which is fine.
 *   - applications this deploy UPDATED are PUT back to their captured prior
 *     body.
 *
 * Rollback is keyed on the application id PingOne returned, never on the
 * name. The client secret sub-resource is never touched by this config
 * type in either direction, so there is nothing to restore there.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ApplicationRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this application - remove it. A 404 means it is
        // already gone, which is fine.
        if (entry.id) {
          const del = await client.request('DELETE', `/applications/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete application "${entry.name}": ${pingOneErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this application - restore its captured prior body.
        const res = await client.request('PUT', `/applications/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore application "${entry.name}": ${pingOneErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} application(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} application(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
