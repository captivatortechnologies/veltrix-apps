import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'
import { buildConnectionRestoreBody, type Connection } from './_shared'

/**
 * Undo a connections deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT the prior NON-SECRET body (restore — see
 * buildConnectionRestoreBody), or — when the connection was newly created
 * (prior body null) — DELETE it (DELETE requires the *Connection-suffixed
 * type as a query parameter, distinct from the *Definition write type).
 * Applied over the Sumo Logic Management API.
 *
 * ⚠ SECRET LIMITATION: Webhook authorization headers and a ServiceNow password
 * are write-only and Sumo Logic never echoes them back on read, so they are
 * NEVER captured during deploy. A connection whose secrets changed keeps
 * whatever the deploy set; the previous values cannot be recovered and must be
 * re-entered by an operator if needed.
 *
 * API: https://www.sumologic.com/help/docs/api/connection-management/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; connectionId: string | null; connectionType: string; connection: Connection | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for connection rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { connectionId, connectionType, connection } of previous) {
      if (connectionId == null) {
        // A created connection whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/connections/${encodeURIComponent(connectionId)}`
      if (connection) {
        await sendJson('PUT', path, headers, buildConnectionRestoreBody(connection))
        restored++
      } else {
        await sendJson('DELETE', `${path}?type=${encodeURIComponent(connectionType || 'WebhookConnection')}`, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back connections: ${restored} restored (secrets excluded — see Coverage notes), ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
