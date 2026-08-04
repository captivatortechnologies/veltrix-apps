import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, sendJson } from '../../lib/vectraApi'

/**
 * Undo a match-assignments deploy from rollbackData.previous (written by deploy()):
 * for each ruleset uuid, DELETE the devices this deploy ADDED and re-POST the
 * devices this deploy REMOVED — inverting the reconciliation exactly. Applied over
 * the Vectra Detect REST API (v2.5, 443).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ uuid: string; added: string[]; removed: string[] }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for match assignment rollback' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let readded = 0
  let unassigned = 0
  try {
    for (const { uuid, added, removed } of previous) {
      for (const deviceSerial of added) {
        await sendJson('DELETE', `${base}/vectra-match/assignment`, headers, { uuid, device_serial: deviceSerial })
        unassigned++
      }
      if (removed.length > 0) {
        await sendJson('POST', `${base}/vectra-match/assignment`, headers, { uuid, device_serials: removed })
        readded += removed.length
      }
    }
    return { success: true, message: `Rolled back match assignments: ${unassigned} unassigned, ${readded} re-assigned.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
