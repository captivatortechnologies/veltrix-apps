import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { normalizeItem, groupByTeam, toBatchEntry, batchReplaceProfiles, snapshotTeamProfiles, type PriorProfile } from './_shared'

/**
 * Deploy Fleet MDM configuration profiles via the REST API's WHOLE-LIST-REPLACE
 * batch endpoint, one call per team scope:
 *
 *   snapshot (rollback): download every existing profile's content for the scope
 *   replace:             POST /api/v1/fleet/configuration_profiles/batch?fleet_id=<team>
 *                         with EVERY profile declared for that scope
 *
 * Canvas → Fleet mapping (per profile):
 *   profileContent → profile (base64-encoded)
 *   displayName    → display_name (required by Fleet for Windows/DDM profiles)
 *   labelsInclude* / labelsExcludeAny → labels_include_all / labels_include_any / labels_exclude_any
 *   teamId         → fleet_id query param (blank = "Unassigned")
 *
 * rollbackData records the prior full profile list PER TEAM SCOPE (with content)
 * so rollback can replay the exact same batch call and restore it. Verify the
 * request bodies against a live Fleet (fleetdm) instance.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const rawItems = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for configuration-profile deployment' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const items = rawItems.map((item) => normalizeItem(item.fields)).filter((item) => item.name)
  const groups = groupByTeam(items)

  const priorByTeam: Array<{ teamId: number | undefined; profiles: PriorProfile[] }> = []
  const appliedTeams: string[] = []

  try {
    for (const [teamId, teamItems] of groups) {
      const prior = await snapshotTeamProfiles(base, headers, teamId)
      priorByTeam.push({ teamId, profiles: prior })

      const entries = teamItems.map((item) => toBatchEntry(item, Buffer.from(item.profileContent, 'utf8').toString('base64')))
      await batchReplaceProfiles(base, headers, teamId, entries)
      appliedTeams.push(teamId === undefined ? 'Unassigned' : String(teamId))
    }

    return {
      success: true,
      message: `Applied configuration profiles for ${appliedTeams.length} scope(s): ${appliedTeams.join(', ') || '(none)'}`,
      artifacts: { appliedTeams, profileCount: items.length },
      rollbackData: { priorByTeam },
    }
  } catch (error) {
    return {
      success: false,
      message: `Configuration-profile deploy failed after ${appliedTeams.length} scope(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { appliedTeams },
      rollbackData: { priorByTeam },
    }
  }
}
