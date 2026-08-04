import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'
import type { OwnedSections } from './_shared'

/**
 * Undo a global-settings deploy from rollbackData.previous (written by
 * deploy()): PATCH the prior owned sections back via PATCH /api/v1/fleet/
 * config. Verify against a live Fleet (fleetdm) instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: OwnedSections }
  if (!data.previous) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for global-settings rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  try {
    await sendJson('PATCH', `${base}${FLEET_API_BASE}/config`, headers, data.previous)
    return { success: true, message: 'Restored prior Fleet global settings.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
