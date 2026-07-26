import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient, xsoarErrorMessage } from '../../lib/xsoar'
import type { IntegrationInstanceRollbackEntry } from './deploy'

/** XSOAR content-version convention: -1 overrides on write. */
const OVERRIDE_VERSION = -1

/**
 * Roll back integration instances using the state captured during deploy:
 *   - instances that were created are deleted (DELETE /settings/integration/{id})
 *   - instances that were updated are restored (PUT /settings/integration) to
 *     their prior body
 * An instance already deleted out-of-band (404) is treated as success.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IntegrationInstanceRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request(
            'DELETE',
            `/settings/integration/${encodeURIComponent(entry.id)}`,
          )
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete integration instance "${entry.name}": ${xsoarErrorMessage(res)}`)
          }
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', '/settings/integration', {
          body: { ...entry.prior, version: OVERRIDE_VERSION },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore integration instance "${entry.name}": ${xsoarErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} integration instance(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
