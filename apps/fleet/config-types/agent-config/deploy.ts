import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'
import { getFleetConfig, parseAgentOptions } from './_shared'

/**
 * Deploy the Fleet org-wide agent options (a singleton) via the REST API:
 *   read (rollback): GET   /api/v1/fleet/config   → snapshot the prior agent_options
 *   update:          PATCH /api/v1/fleet/config    with { agent_options: <parsed JSON> }
 *
 * Canvas → Fleet mapping:
 *   agentOptions (JSON textarea) → agent_options (parsed JSON)
 *
 * rollbackData records the prior agent_options (null when the config had none) so
 * rollback can PATCH it back. Verify the request body against a live Fleet
 * (fleetdm) instance.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for agent-config deployment' }
  }

  const item = items[0]
  if (!item) {
    return { success: false, message: 'No agent configuration to apply.' }
  }

  let agentOptions: unknown
  try {
    agentOptions = parseAgentOptions(item.fields.agentOptions)
  } catch (error) {
    return { success: false, message: `Agent Options is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}` }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  try {
    const prior = await getFleetConfig(base, headers)
    const previousAgentOptions = prior?.agent_options ?? null

    await sendJson('PATCH', `${base}${FLEET_API_BASE}/config`, headers, { agent_options: agentOptions })

    return {
      success: true,
      message: 'Applied Fleet org agent options.',
      artifacts: { applied: ['agent-options'] },
      rollbackData: { previousAgentOptions },
    }
  } catch (error) {
    return {
      success: false,
      message: `Agent-config deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
