import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'
import { getFleetConfig, extractOwnedSections, buildPatchBody } from './_shared'

/**
 * Deploy Fleet's non-secret global settings via the REST API:
 *   read (rollback): GET   /api/v1/fleet/config   → snapshot the owned sections
 *   update:          PATCH /api/v1/fleet/config    with the merged owned sections
 *
 * See canvas.yaml / README for the exact org_info / server_settings / features /
 * host_expiry_settings / activity_expiry_settings / webhook_settings /
 * fleet_desktop mapping. rollbackData records the prior owned sections so
 * rollback can PATCH them back exactly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for global-settings deployment' }
  }

  const item = items[0]
  if (!item) {
    return { success: false, message: 'No global settings to apply.' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  try {
    const current = await getFleetConfig(base, headers)
    const previous = extractOwnedSections(current)
    const body = buildPatchBody(previous, item.fields)

    await sendJson('PATCH', `${base}${FLEET_API_BASE}/config`, headers, body)

    return {
      success: true,
      message: 'Applied Fleet global settings.',
      artifacts: { sections: Object.keys(body) },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Global-settings deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
