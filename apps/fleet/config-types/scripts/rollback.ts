import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendMultipart, fleetRequest, FLEET_API_BASE } from '../../lib/fleetApi'

interface PriorScript {
  filename: string
  teamId: number | undefined
  priorScriptId: number | null
  priorContent: string | null
  createdScriptId?: number
}

/**
 * Undo a script deploy from rollbackData.previous (written by deploy()): for
 * each entry, PATCH the prior content back to the script we updated, or DELETE
 * the script we created. A script that existed but whose content could not be
 * downloaded during deploy (best-effort snapshot failure) is reported as a
 * rollback failure for that item rather than silently left as-is or blindly
 * overwritten with nothing.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorScript[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for script rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  const skipped: string[] = []

  try {
    for (const entry of previous) {
      if (entry.priorScriptId !== null) {
        if (entry.priorContent === null) {
          skipped.push(entry.filename)
          continue
        }
        await sendMultipart(
          'PATCH',
          `${base}${FLEET_API_BASE}/scripts/${entry.priorScriptId}`,
          headers,
          [],
          [{ name: 'script', filename: entry.filename, content: entry.priorContent, contentType: 'text/plain' }],
        )
        restored++
      } else if (entry.createdScriptId !== undefined) {
        await fleetRequest(`${base}${FLEET_API_BASE}/scripts/${entry.createdScriptId}`, { method: 'DELETE', headers })
        deleted++
      }
    }

    if (skipped.length > 0) {
      return {
        success: false,
        message: `Rolled back scripts: ${restored} restored, ${deleted} removed. Could not restore ${skipped.length} script(s) whose prior content was never captured: ${skipped.join(', ')}.`,
      }
    }
    return { success: true, message: `Rolled back scripts: ${restored} restored, ${deleted} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
