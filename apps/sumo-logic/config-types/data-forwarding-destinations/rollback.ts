import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'
import { buildDestinationRestoreBody, type DataForwardingDestination } from './_shared'

/**
 * Undo a data-forwarding-destinations deploy from rollbackData.previous
 * (written by deploy()): for each entry, PUT the prior NON-SECRET body (restore
 * — see buildDestinationRestoreBody), or — when the destination was newly
 * created (prior body null) — DELETE it. Applied over the Sumo Logic Management
 * API.
 *
 * ⚠ SECRET LIMITATION: AWS Access Key ID / Secret Access Key are write-only and
 * Sumo Logic never echoes them back on read, so they are NEVER captured during
 * deploy. A destination whose credentials were changed keeps whatever
 * credentials the deploy set — the previous ones cannot be recovered and must
 * be re-entered by an operator if needed.
 *
 * API: https://help.sumologic.com/docs/api/data-forwarding/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ destinationName: string; destinationId: string | null; destination: DataForwardingDestination | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for data forwarding destination rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { destinationId, destination } of previous) {
      if (destinationId == null) {
        // A created destination whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/logsDataForwarding/destinations/${encodeURIComponent(destinationId)}`
      if (destination) {
        await sendJson('PUT', path, headers, buildDestinationRestoreBody(destination))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back data forwarding destinations: ${restored} restored (credentials excluded — see Coverage notes), ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
