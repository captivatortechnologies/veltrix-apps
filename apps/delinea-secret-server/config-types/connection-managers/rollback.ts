import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { buildConnectorRestoreBody } from './_shared'
import type { ConnectorRollbackEntry } from './deploy'

/**
 * Undo a connection-managers deploy from rollbackData.previous (written by
 * deploy()): for each connector that already existed, PATCH
 * /distributed-engine/site-connector/{id} to restore its prior body; a newly
 * created connector (existed=false) is left in place — this app does not
 * delete connection managers. Applied over the Secret Server REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: ConnectorRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let left = 0
  try {
    for (const entry of previous) {
      if (!entry.existed || !entry.prior || entry.connectorId === null) {
        // A newly created connector (or one whose id we never learned) — leave it in place.
        left++
        continue
      }
      const res = await client.request('PATCH', `/distributed-engine/site-connector/${entry.connectorId}`, {
        body: buildConnectorRestoreBody(entry.prior),
      })
      if (!res.ok) throw new Error(`Failed to restore connection manager "${entry.name}": ${secretServerErrorMessage(res)}`)
      restored++
    }
    return { success: true, message: `Rolled back connection managers: ${restored} restored${left ? `, ${left} left in place` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
