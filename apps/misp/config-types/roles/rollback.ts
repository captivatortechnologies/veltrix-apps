import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'
import type { MispRole } from './_shared'

/**
 * Undo a roles deploy from rollbackData.previous (written by deploy()): for each
 * entry with a prior body, POST /admin/roles/edit/<id> to restore it; a newly
 * created role (prior body null) is deleted via POST /admin/roles/delete/<id> —
 * MISP rejects deleting a role still assigned to a user, which surfaces here as a
 * clear rollback failure rather than being silently skipped. Applied over the
 * MISP REST API (443). Verify /admin/roles/edit/<id> + /admin/roles/delete/<id>
 * against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; roleId: number | string | null; role: MispRole | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for role rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { roleId, role } of previous) {
      if (roleId == null) continue // never learned an id — nothing addressable to undo
      if (role) {
        await sendJson('POST', `${base}/admin/roles/edit/${encodeURIComponent(String(roleId))}`, headers, { Role: role })
        restored++
      } else {
        await sendJson('POST', `${base}/admin/roles/delete/${encodeURIComponent(String(roleId))}`, headers, {})
        deleted++
      }
    }
    return { success: true, message: `Rolled back roles: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
