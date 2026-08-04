import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'
import type { MispUser } from './_shared'

/**
 * Undo a users deploy from rollbackData.previous (written by deploy()): for each
 * entry with a prior body, POST /admin/users/edit/<id> to restore it; a newly
 * created user (prior body null) is deleted via POST /admin/users/delete/<id>.
 * Never touches a password or auth key — see config-types/users/_shared.ts.
 * Applied over the MISP REST API (443). Verify /admin/users/edit/<id> +
 * /admin/users/delete/<id> against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ email: string; userId: number | string | null; user: MispUser | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for user rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { userId, user } of previous) {
      if (userId == null) continue // never learned an id — nothing addressable to undo
      if (user) {
        await sendJson('POST', `${base}/admin/users/edit/${encodeURIComponent(String(userId))}`, headers, { User: user })
        restored++
      } else {
        await sendJson('POST', `${base}/admin/users/delete/${encodeURIComponent(String(userId))}`, headers, {})
        deleted++
      }
    }
    return { success: true, message: `Rolled back users: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
