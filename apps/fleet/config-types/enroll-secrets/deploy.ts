import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { normalizeItem, groupByScope, getSecretsForScope, setSecretsForScope } from './_shared'

/**
 * Deploy Fleet enroll secrets via the REST API's WHOLE-LIST-REPLACE endpoints,
 * one call per scope:
 *   snapshot (rollback): GET   /api/v1/fleet/spec/enroll_secret       (global)
 *                         GET   /api/v1/fleet/fleets/{id}/secrets      (team)
 *   replace:              POST  /api/v1/fleet/spec/enroll_secret       (global)
 *                         PATCH /api/v1/fleet/fleets/{id}/secrets      (team)
 *   with EVERY secret declared for that scope
 *
 * rollbackData records the prior full secret list PER SCOPE so rollback can
 * replay the same replace call and restore it exactly (an empty prior list
 * restores "no secrets" for that scope). Secret values never appear in the
 * result message — only counts and labels.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const rawItems = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for enroll-secret deployment' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const items = rawItems.map((item) => normalizeItem(item.fields)).filter((item) => item.label && item.value)
  const groups = groupByScope(items)

  const priorByScope: Array<{ teamId: number | undefined; secrets: string[] }> = []
  const appliedScopes: string[] = []

  try {
    for (const [teamId, scopeItems] of groups) {
      const prior = await getSecretsForScope(base, headers, teamId)
      priorByScope.push({ teamId, secrets: prior })

      await setSecretsForScope(base, headers, teamId, scopeItems.map((item) => item.value))
      appliedScopes.push(teamId === undefined ? 'global' : `team ${teamId}`)
    }

    return {
      success: true,
      message: `Applied enroll secrets for ${appliedScopes.length} scope(s): ${appliedScopes.join(', ') || '(none)'}`,
      artifacts: { appliedScopes, secretCount: items.length },
      rollbackData: { priorByScope },
    }
  } catch (error) {
    return {
      success: false,
      message: `Enroll-secret deploy failed after ${appliedScopes.length} scope(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { appliedScopes },
      rollbackData: { priorByScope },
    }
  }
}
