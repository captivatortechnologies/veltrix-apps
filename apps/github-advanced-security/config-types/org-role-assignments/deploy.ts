import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson, type GithubClient } from '../../lib/githubApi'
import { desiredFromItem, findRoleByName, teamIsAssigned, type OrgRole, type OrgRoleTeam, type OrgRoleAssignmentRollbackEntry } from './_shared'

/**
 * Deploy organization role → team assignments over the REST API:
 *   resolve: GET /orgs/{org}/organization-roles                        (role_name -> role_id, cached per org)
 *   read:    GET /orgs/{org}/organization-roles/{role_id}/teams        (is the team already assigned?)
 *   apply:   PUT /orgs/{org}/organization-roles/teams/{team_slug}/{role_id}
 *
 * (org, team, role_name) is the stable identity. Assignment is a boolean
 * membership, not a document with fields to diff — an already-assigned team
 * is left untouched (existed=true, nothing to roll back). rollbackData
 * records, per assignment, whether this deploy created it so rollback / a
 * later reconcile can remove exactly what was added.
 */

async function loadPriorEntries(ctx: DeployContext): Promise<OrgRoleAssignmentRollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: OrgRoleAssignmentRollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as OrgRoleAssignmentRollbackEntry[]) : []
  } catch {
    return []
  }
}

async function listRoles(client: GithubClient, org: string): Promise<{ ok: true; roles: OrgRole[] } | { ok: false; reason: string }> {
  const res = await client.listOrgRoles(org)
  if (!res.ok) return { ok: false, reason: `${res.status} ${githubErrorMessage(res)}` }
  const roles = parseJson<OrgRole[]>(res.body)
  return { ok: true, roles: Array.isArray(roles) ? roles : [] }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const prior = await loadPriorEntries(ctx)
  const entries: OrgRoleAssignmentRollbackEntry[] = []
  const applied: string[] = []
  const skipped: string[] = []
  const failures: string[] = []
  const roleListCache = new Map<string, OrgRole[]>()
  const teamListCache = new Map<string, OrgRoleTeam[]>()

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    const fullName = `${desired.org || '(no org)'}/${desired.team || '(no team)'} -> ${desired.roleName || '(no role)'}`
    if (!desired.org || !desired.team || !desired.roleName) {
      skipped.push(fullName)
      continue
    }

    if (!roleListCache.has(desired.org)) {
      const listed = await listRoles(client, desired.org)
      if (!listed.ok) {
        skipped.push(`${fullName} (${listed.reason})`)
        continue
      }
      roleListCache.set(desired.org, listed.roles)
    }
    const role = findRoleByName(roleListCache.get(desired.org) ?? [], desired.roleName)
    if (!role?.id) {
      skipped.push(`${fullName} (role "${desired.roleName}" not found in ${desired.org})`)
      continue
    }

    const teamCacheKey = `${desired.org}/${role.id}`
    if (!teamListCache.has(teamCacheKey)) {
      const res = await client.listTeamsForOrgRole(desired.org, role.id)
      teamListCache.set(teamCacheKey, res.ok ? parseJson<OrgRoleTeam[]>(res.body) ?? [] : [])
    }
    const assignedTeams = teamListCache.get(teamCacheKey) ?? []
    const alreadyAssigned = teamIsAssigned(assignedTeams, desired.team)

    try {
      if (!alreadyAssigned) {
        const res = await client.assignOrgRoleToTeam(desired.org, desired.team, role.id)
        if (!res.ok) throw new Error(`assign: ${res.status} ${githubErrorMessage(res)}`)
        assignedTeams.push({ slug: desired.team })
      }
      entries.push({ itemId: item.id, org: desired.org, team: desired.team, roleName: desired.roleName, roleId: role.id, existed: alreadyAssigned })
      applied.push(fullName)
    } catch (error) {
      failures.push(`${fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Reconcile: remove assignments THIS app made previously but no longer declares.
  const declaredItems = new Set(items.map((it) => it.id).filter(Boolean))
  const declaredKeys = new Set(entries.map((e) => `${e.org}::${e.team.toLowerCase()}::${e.roleName.toLowerCase()}`))
  for (const p of prior) {
    if (p.existed) continue // we never created this one — never remove it
    const key = `${p.org}::${p.team.toLowerCase()}::${p.roleName.toLowerCase()}`
    if ((p.itemId && declaredItems.has(p.itemId)) || declaredKeys.has(key)) continue
    if (p.roleId == null) continue
    const res = await client.removeOrgRoleFromTeam(p.org, p.team, p.roleId)
    if (!res.ok && res.status !== 404) {
      failures.push(`unassign ${p.org}/${p.team} -> ${p.roleName}: ${res.status} ${githubErrorMessage(res)}`)
    }
  }

  const skipNote = skipped.length ? ` (skipped ${skipped.length}: ${skipped.join(', ')})` : ''
  if (failures.length > 0) {
    return {
      success: false,
      message: `Applied ${applied.length} assignment(s); ${failures.length} failed: ${failures.join(' | ')}${skipNote}`,
      artifacts: { applied, skipped, failures },
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Applied ${applied.length} organization role assignment(s): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { entries },
  }
}
