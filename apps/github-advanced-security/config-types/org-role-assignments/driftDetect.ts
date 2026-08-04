import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import { desiredFromItem, findRoleByName, teamIsAssigned, type OrgRole, type OrgRoleTeam } from './_shared'

/**
 * Drift for organization role assignments: for each declared (org, team,
 * role), confirm the team is still in the role's assigned-teams list.
 * Read-only — GET the org's roles and the role's teams. Best-effort: an org
 * whose roles can't be listed, or a role that no longer resolves by name, is
 * skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const roleListCache = new Map<string, OrgRole[] | null>()
  const teamListCache = new Map<string, OrgRoleTeam[] | null>()

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    if (!desired.org || !desired.team || !desired.roleName) continue
    const fullName = `${desired.org}/${desired.team} -> ${desired.roleName}`

    if (!roleListCache.has(desired.org)) {
      const res = await client.listOrgRoles(desired.org)
      roleListCache.set(desired.org, res.ok ? parseJson<OrgRole[]>(res.body) ?? [] : null)
    }
    const roles = roleListCache.get(desired.org)
    if (roles == null) continue

    const role = findRoleByName(roles, desired.roleName)
    if (!role?.id) continue // role no longer exists — nothing meaningful to diff

    const teamCacheKey = `${desired.org}/${role.id}`
    if (!teamListCache.has(teamCacheKey)) {
      const res = await client.listTeamsForOrgRole(desired.org, role.id)
      teamListCache.set(teamCacheKey, res.ok ? parseJson<OrgRoleTeam[]>(res.body) ?? [] : null)
    }
    const teams = teamListCache.get(teamCacheKey)
    if (teams == null) continue

    if (!teamIsAssigned(teams, desired.team)) {
      diffs.push({ field: `${fullName}.assigned`, expected: true, actual: false, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
