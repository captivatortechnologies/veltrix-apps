import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveRole, type GraylogRole } from './_shared'

/**
 * Undo a roles deploy from rollbackData.previous (written by deploy()): for
 * each entry, PUT /api/roles/{name} with the prior permission set (restore),
 * or — when the role was newly created (prior null) — DELETE
 * /api/roles/{name} to remove it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; role: GraylogRole | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for role rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { name, role } of previous) {
      const path = `${base}/api/roles/${encodeURIComponent(name)}`
      if (role) {
        await sendJson('PUT', path, headers, bodyFromLiveRole(role))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return { success: true, message: `Rolled back roles: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
