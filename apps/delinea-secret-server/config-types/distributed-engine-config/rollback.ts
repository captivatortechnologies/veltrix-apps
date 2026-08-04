import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { buildDistributedEngineConfigRestoreBody, type LiveDistributedEngineConfig } from './_shared'

/**
 * Restore the Distributed Engine configuration singleton to the snapshot
 * captured in rollbackData.prior (written by deploy()). Applied over the
 * Secret Server REST API: PATCH /distributed-engine/configuration.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { prior?: LiveDistributedEngineConfig }
  const prior = data.prior
  if (!prior) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  try {
    const res = await client.request('PATCH', '/distributed-engine/configuration', { body: buildDistributedEngineConfigRestoreBody(prior) })
    if (!res.ok) throw new Error(`Failed to restore the Distributed Engine configuration: ${secretServerErrorMessage(res)}`)
    return { success: true, message: 'Rolled back the Distributed Engine configuration.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
