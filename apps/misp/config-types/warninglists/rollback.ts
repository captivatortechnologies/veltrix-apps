import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'

/**
 * Undo a warninglists deploy from rollbackData.previous (written by deploy()): for
 * each entry, re-apply the prior enabled state — POST /warninglists/toggleEnable
 * with { id, enabled: <enabledBefore> }. Applied over the MISP REST API (443).
 * Verify /warninglists/toggleEnable against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; warninglistId: number | string; enabledBefore: boolean }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for warninglist rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  try {
    for (const { warninglistId, enabledBefore } of previous) {
      await sendJson('POST', `${base}/warninglists/toggleEnable`, headers, { id: warninglistId, enabled: enabledBefore })
      restored++
    }
    return { success: true, message: `Rolled back warninglists: ${restored} restored.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
