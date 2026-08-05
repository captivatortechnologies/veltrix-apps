import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, sendJson, DELETE_AUTH_HINT } from '../../lib/soarApi'
import type { SoarRole } from './_shared'

/**
 * Undo a roles deploy from rollbackData.previous (written by deploy()): for
 * each entry with a prior body, POST /rest/role/<id> restores it; a newly
 * created role (prior body null) is deleted via DELETE /rest/role/<id> — which
 * requires a user-authenticated credential (see lib/soarApi.ts), and SOAR
 * rejects deleting a role still assigned to a user, both of which surface here
 * as a clear rollback failure rather than being silently skipped.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; roleId: number | string | null; role: SoarRole | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: 'Missing credential for role rollback' }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { roleId, role } of previous) {
      if (roleId == null) continue
      const url = `${base}/rest/role/${encodeURIComponent(String(roleId))}`
      if (role) {
        await sendJson('POST', url, headers, role)
        restored++
      } else {
        await sendJson('DELETE', url, headers)
        deleted++
      }
    }
    return { success: true, message: `Rolled back roles: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, message: `Rollback failed: ${msg} — ${DELETE_AUTH_HINT}` }
  }
}
