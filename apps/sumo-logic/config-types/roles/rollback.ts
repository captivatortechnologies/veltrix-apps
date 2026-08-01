import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'
import type { Role } from './_shared'

/**
 * Undo a roles deploy from rollbackData.previous (written by deploy()): for each
 * entry, PUT /roles/<id> with the prior role body (restore), or — when the role
 * was newly created (prior body null) — DELETE /roles/<id> to remove it. Applied
 * over the Sumo Logic Management API.
 *
 * API: https://www.sumologic.com/help/docs/api/role-management-v2/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; roleId: string | null; role: Role | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for role rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { roleId, role } of previous) {
      if (roleId == null) {
        // A created role whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/roles/${encodeURIComponent(roleId)}`
      if (role) {
        const { id: _omit, ...body } = role
        await sendJson('PUT', path, headers, body)
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back roles: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
