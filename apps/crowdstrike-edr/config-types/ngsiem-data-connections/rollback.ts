import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import { CONNECTION_ENTITY, CONNECTION_STATUS, type ConnectionRollbackEntry } from './deploy'

/**
 * Roll back data connections using the state captured during deploy:
 *   - connections that were created are deleted (DELETE …?ids=<id>)
 *   - connections that were updated are patched back to their prior NON-SECRET
 *     fields (name, parser, repository, description) and status
 *
 * ⚠ The credential is never restored — it was never read back or stored, so a
 * rolled-back connection keeps whatever credential the deployment set. Rotate it
 * through the Falcon console if needed. `connector_type` is immutable and cannot
 * be restored via update; a created connection is deleted instead.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ConnectionRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this connection — remove it. 404 means it never finished
        // creating or is already gone, which is the desired state.
        if (entry.id) {
          const res = await client.request(
            'DELETE',
            `${CONNECTION_ENTITY}?ids=${encodeURIComponent(entry.id)}`,
          )
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(`Failed to delete connection "${entry.name}": ${deleteFailure}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this connection — restore the captured non-secret values.
        const restore: Record<string, unknown> = {}
        if (entry.prior.name !== undefined) restore.name = entry.prior.name
        if (entry.prior.parser !== undefined) restore.parser = entry.prior.parser
        if (entry.prior.description !== undefined) restore.description = entry.prior.description
        // Rebuild the non-secret config so a wholesale `config` replace keeps both
        // the source endpoint and the repository (the credential is never restored).
        const config: Record<string, unknown> = {}
        if (entry.prior.endpoint !== undefined) config.endpoint = entry.prior.endpoint
        if (entry.prior.repository !== undefined) config.repository = entry.prior.repository
        if (Object.keys(config).length > 0) restore.config = config

        const res = await client.request(
          'PATCH',
          `${CONNECTION_ENTITY}?ids=${encodeURIComponent(entry.id)}`,
          { body: restore },
        )
        const restoreFailure = falconFailure(res)
        if (restoreFailure) {
          throw new Error(`Failed to restore connection "${entry.name}": ${restoreFailure}`)
        }

        // Status lives on a separate endpoint — restore the prior value best-effort.
        if (entry.prior.status !== undefined) {
          await client.request('PATCH', `${CONNECTION_STATUS}?ids=${encodeURIComponent(entry.id)}`, {
            body: { status: entry.prior.status },
          })
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} data connection(s): ${reverted.join(', ')}. Credentials are not restored by rollback — rotate in the Falcon console if needed.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} connection(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
