import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { ConnectorRollbackEntry } from './deploy'

/**
 * Roll back connectors using the state captured during deploy:
 *   - connectors this deploy created are deleted (DELETE /settings/connectors/{id})
 *   - connectors this deploy updated are PUT back to their captured prior body
 *
 * SECRET CAVEAT: a restored update replays only the NON-SECRET prior fields
 * (name, type, network, schedule). The connector's `params` (cloud
 * credentials) are write-only — Tenable never returns them, so a prior secret
 * cannot be captured and therefore cannot be restored. Omitting params from the
 * restore PUT leaves whatever secrets are live in place, which is the safest
 * available outcome (rollback never plants a stale or blank credential).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ConnectorRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this connector — remove it. 404 means it was never
        // created (or already removed), which is the desired end state.
        if (entry.id !== undefined) {
          const res = await client.request('DELETE', `/settings/connectors/${entry.id}`)
          if (!res.ok && res.status !== 404) {
            throw new Error(`Failed to delete connector "${entry.name}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.id !== undefined && entry.prior) {
        // Deploy updated this connector — restore the captured prior NON-SECRET
        // body, wrapped in a "connector" envelope. params are intentionally
        // never sent (write-only; the prior secret was never readable).
        const connector: Record<string, unknown> = {}
        if (entry.prior.name !== undefined) connector.name = entry.prior.name
        if (entry.prior.type !== undefined) connector.type = entry.prior.type
        if (entry.prior.network_id !== undefined) connector.network_uuid = entry.prior.network_id
        if (entry.prior.schedule !== undefined && entry.prior.schedule !== null) {
          connector.schedule = entry.prior.schedule
        }

        const res = await client.request('PUT', `/settings/connectors/${entry.id}`, {
          body: { connector },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore connector "${entry.name}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} connector(s): ${reverted.join(', ')}. Note: write-only credentials (params) are not restored — only name, type, network and schedule.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} connector(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
