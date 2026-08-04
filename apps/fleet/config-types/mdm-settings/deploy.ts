import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { parseScope, getMdm, setMdm, buildMdmPatch } from './_shared'

interface PriorMdm {
  teamId: number | undefined
  priorMdm: Record<string, unknown>
}

/**
 * Deploy Fleet MDM settings per scope via the REST API:
 *   read (rollback): GET   /api/v1/fleet/config              (global scope)
 *                     GET   /api/v1/fleet/fleets/{id}          (team scope)
 *   update:          PATCH /api/v1/fleet/config { mdm }        (global scope)
 *                     PATCH /api/v1/fleet/fleets/{id} { mdm }   (team scope, Premium)
 *
 * Each declared item configures ONE scope. rollbackData records the prior
 * `mdm` block per scope so rollback can PATCH it back exactly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for MDM-settings deployment' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: PriorMdm[] = []
  const appliedScopes: string[] = []

  try {
    for (const item of items) {
      const scope = parseScope(item.fields.teamId)
      const current = await getMdm(base, headers, scope)
      previous.push({ teamId: scope.teamId, priorMdm: current })

      const patch = buildMdmPatch(current, item.fields, scope)
      await setMdm(base, headers, scope, patch)
      appliedScopes.push(scope.teamId === undefined ? 'global' : `team ${scope.teamId}`)
    }

    return {
      success: true,
      message: `Applied MDM settings for ${appliedScopes.length} scope(s): ${appliedScopes.join(', ') || '(none)'}`,
      artifacts: { appliedScopes },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `MDM-settings deploy failed after ${appliedScopes.length} scope(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { appliedScopes },
      rollbackData: { previous },
    }
  }
}
