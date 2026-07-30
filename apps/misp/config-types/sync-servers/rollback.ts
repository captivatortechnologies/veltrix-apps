import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'
import type { MispServer } from './_shared'

/**
 * Undo a sync-servers deploy from rollbackData.previous (written by deploy()): for
 * each entry with a prior body, POST /servers/edit/<id> to restore it; a newly
 * created server (prior body null) is left in place — MISP has no simple server
 * delete over this seam. Applied over the MISP REST API (443). Verify
 * /servers/edit/<id> against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; url: string; serverId: number | string | null; server: MispServer | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for sync server rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let left = 0
  try {
    for (const { serverId, server } of previous) {
      if (serverId == null || !server) {
        // A newly created server (or one whose id we never learned) — leave it in place.
        left++
        continue
      }
      await sendJson('POST', `${base}/servers/edit/${encodeURIComponent(String(serverId))}`, headers, { Server: server })
      restored++
    }
    return { success: true, message: `Rolled back sync servers: ${restored} restored${left ? `, ${left} left in place` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
