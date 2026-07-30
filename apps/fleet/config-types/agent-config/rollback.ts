import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'

/**
 * Undo an agent-config deploy from rollbackData.previousAgentOptions (written by
 * deploy()): PATCH the prior org agent_options back via PATCH /api/v1/fleet/
 * config. Verify against a live Fleet (fleetdm) instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previousAgentOptions?: unknown }
  if (data.previousAgentOptions === undefined) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for agent-config rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  try {
    await sendJson('PATCH', `${base}${FLEET_API_BASE}/config`, headers, { agent_options: data.previousAgentOptions ?? {} })
    return { success: true, message: 'Restored prior Fleet org agent options.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
