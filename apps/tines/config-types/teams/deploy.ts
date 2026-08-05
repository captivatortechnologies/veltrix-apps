import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage, parseJson, type TinesClient } from '../../lib/tinesApi'
import { buildTeamBody, extractTeamSpecs, type LiveTeam } from './_shared'

/** Per-team rollback record captured during deploy. */
export interface TeamRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: LiveTeam
}

/**
 * Deploy Tines teams over the REST API:
 *   read (rollback): GET  /api/v1/teams          -> find each live team by name
 *   create:          POST /api/v1/teams           <- { name }
 *   update:          PUT  /api/v1/teams/{id}       <- { name }
 *
 * The name is the stable identity used to upsert. rollbackData records, per
 * team, whether it existed and its prior body — so rollback can restore a
 * renamed team or delete a newly created one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractTeamSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: TeamRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const existing = await listTeams(client)
    const byName = new Map(existing.filter((t) => t.name).map((t) => [String(t.name).toLowerCase(), t]))

    for (const spec of specs) {
      const body = buildTeamBody(spec)
      const live = byName.get(spec.name.toLowerCase())

      if (live && live.id !== undefined) {
        rollbackState.push({ name: spec.name, existed: true, id: String(live.id), prior: live })
        const res = await client.request('PUT', `/teams/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update team "${spec.name}": ${tinesErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/teams', { body })
        if (!res.ok) throw new Error(`Failed to create team "${spec.name}": ${tinesErrorMessage(res)}`)
        const created = parseJson<LiveTeam>(res.body)
        if (!created?.id) throw new Error(`Team "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, existed: false, id: String(created.id) })
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} team(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Team deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List all teams in the tenant; throws on a non-OK response. */
export async function listTeams(client: TinesClient): Promise<LiveTeam[]> {
  const res = await client.getAll<LiveTeam>('/teams', 'teams', { scope: 'standard' })
  if (!res.ok) {
    throw new Error(`Failed to list teams: ${tinesErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
