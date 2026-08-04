import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigClient, type SysdigTeam, type SysdigUserRole, type SysdigUserLight } from '../../lib/sysdigApi'
import { buildTeamBody, findTeamByName, normalizeBoolean, parseUserRoles, splitList } from './_shared'

/**
 * Deploy Sysdig Secure teams over the REST API:
 *   find:    GET    /api/teams                (list all, match by name)
 *   create:  POST   /api/teams
 *   update:  PUT    /api/teams/<id>            (carries the live id + version)
 *   remove:  DELETE /api/teams/<id>            (for a disabled team)
 *
 * Zone names and member emails are best-effort resolved to ids against live
 * Sysdig data (GET /platform/v1/zones, GET /api/users/light) — an unresolved
 * reference is dropped with a note in the result message rather than failing
 * the whole team, mirroring how this app treats cross-references elsewhere
 * (e.g. Falco rule names on a runtime policy).
 */
type TeamAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: TeamAction
  teamId: number | null
  prior: SysdigTeam | null
}

async function findLive(client: SysdigClient, name: string): Promise<SysdigTeam | null> {
  try {
    return findTeamByName(await client.listTeams(), name)
  } catch {
    return null
  }
}

async function resolveZoneIds(client: SysdigClient, names: string[], unresolved: string[]): Promise<number[]> {
  const ids: number[] = []
  for (const name of names) {
    try {
      const matches = await client.findZonesByName(name)
      const match = matches.find((z) => String(z.name ?? '').trim() === name)
      if (match?.id != null) ids.push(match.id)
      else unresolved.push(name)
    } catch {
      unresolved.push(name)
    }
  }
  return ids
}

function resolveUserRoles(specs: Array<{ email: string; role: string }>, users: SysdigUserLight[], unresolved: string[]): SysdigUserRole[] {
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]))
  const roles: SysdigUserRole[] = []
  for (const spec of specs) {
    const userId = byEmail.get(spec.email.toLowerCase())
    if (userId === undefined) {
      unresolved.push(spec.email)
      continue
    }
    roles.push({ userId, userName: spec.email, role: spec.role })
  }
  return roles
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let users: SysdigUserLight[] = []
  try {
    users = await client.listUsersLight()
  } catch {
    users = []
  }

  const previous: RollbackEntry[] = []
  const applied: string[] = []
  const unresolvedZones: string[] = []
  const unresolvedEmails: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const enabled = normalizeBoolean(item.fields.enabled, true)

      const existing = await findLive(client, name)
      const existingId = typeof existing?.id === 'number' ? existing.id : null

      if (!enabled) {
        if (existing && existingId != null) {
          await client.deleteTeam(existingId)
          previous.push({ name, action: 'deleted', teamId: existingId, prior: existing })
        } else {
          previous.push({ name, action: 'noop', teamId: null, prior: null })
        }
        applied.push(`${name} (removed)`)
        continue
      }

      const zoneIds = normalizeBoolean(item.fields.allZones, false)
        ? []
        : await resolveZoneIds(client, splitList(item.fields.zoneNames), unresolvedZones)
      const userRoles = resolveUserRoles(parseUserRoles(item.fields.userRolesJson), users, unresolvedEmails)

      const body = buildTeamBody(item.fields, zoneIds, userRoles)
      if (existing && existingId != null) {
        await client.updateTeam(existingId, { ...body, id: existingId, version: existing.version })
        previous.push({ name, action: 'updated', teamId: existingId, prior: existing })
      } else {
        const created = await client.createTeam(body)
        const newId = typeof created?.id === 'number' ? created.id : null
        previous.push({ name, action: 'created', teamId: newId, prior: null })
      }
      applied.push(name)
    }

    const notes: string[] = []
    if (unresolvedZones.length) notes.push(`unresolved zone name(s): ${[...new Set(unresolvedZones)].join(', ')}`)
    if (unresolvedEmails.length) notes.push(`unresolved user email(s): ${[...new Set(unresolvedEmails)].join(', ')}`)

    return {
      success: true,
      message: `Applied ${applied.length} team(s): ${applied.join(', ') || '(none)'}${notes.length ? ` — ${notes.join('; ')}` : ''}`,
      artifacts: { applied, unresolvedZones, unresolvedEmails },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Team deploy failed after ${applied.length} team(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
