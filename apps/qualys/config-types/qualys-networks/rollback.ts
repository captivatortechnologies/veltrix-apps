import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient, qualysWriteError } from '../../lib/qualys'
import { NETWORK_PATH, type NetworkRollbackEntry } from './deploy'

/**
 * Roll back custom networks using the state captured during deploy:
 *   - networks that were updated (renamed) are restored to their prior name
 *   - networks that were CREATED cannot be removed — the classic v2 API has no
 *     delete-network endpoint (only Create Network / Update Network / Network
 *     List / Assign Scanner Appliance to Network are documented). This is a
 *     genuine, permanent Qualys limitation, not a transient failure, so it is
 *     reported rather than treated as a rollback error.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: NetworkRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const restored: string[] = []
  const notRemovable: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        // No delete-network API — the network stays, renamed or not, forever.
        notRemovable.push(entry.label)
        continue
      }
      if (entry.id && entry.prior) {
        const res = await client.post(NETWORK_PATH, { action: 'update', id: entry.id, name: entry.prior.name })
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to restore network "${entry.label}": ${failed}`)
        restored.push(entry.label)
      }
    }

    const parts: string[] = []
    if (restored.length > 0) parts.push(`renamed back ${restored.length} network(s): ${restored.join(', ')}`)
    if (notRemovable.length > 0) {
      parts.push(
        `${notRemovable.length} network(s) created by this deploy could NOT be removed (Qualys has no delete-network API) and remain: ${notRemovable.join(', ')}`,
      )
    }
    return { success: true, message: parts.length > 0 ? parts.join('; ') : 'Nothing to roll back' }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after restoring ${restored.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
