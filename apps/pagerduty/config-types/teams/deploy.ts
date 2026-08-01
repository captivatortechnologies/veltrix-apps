import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import { buildTeamBody, extractTeamSpecs, type LiveTeam } from './_shared'

/** Per-team rollback record captured during deploy. */
export interface TeamRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: LiveTeam
}

/**
 * Deploy PagerDuty teams over the REST API v2:
 *   read (rollback): GET  /teams          → find each live team by name
 *   create:          POST /teams           with { team: {...} }
 *   update:          PUT  /teams/{id}       with { team: {...} }
 *
 * The name is the stable identity used to upsert. rollbackData records, per team,
 * whether it existed and its prior body — so rollback can restore an updated team
 * or delete a newly created one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractTeamSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: TeamRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listTeams(client)
    const byName = new Map(existing.filter((t) => t.name).map((t) => [String(t.name).toLowerCase(), t]))

    for (const spec of specs) {
      const body = { team: buildTeamBody(spec) }
      const live = byName.get(spec.name.toLowerCase())

      if (live && live.id) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/teams/${encodeURIComponent(live.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to update team "${spec.name}": ${pagerDutyErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/teams', { body })
        if (!res.ok) throw new Error(`Failed to create team "${spec.name}": ${pagerDutyErrorMessage(res)}`)
        const created = parseJson<{ team?: LiveTeam }>(res.body)?.team
        if (!created?.id) throw new Error(`Team "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} team(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Team deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all teams in the account; throws on a non-OK response. */
export async function listTeams(client: PagerDutyClient): Promise<LiveTeam[]> {
  const res = await client.getAll<LiveTeam>('/teams', 'teams')
  if (!res.ok) {
    throw new Error(`Failed to list teams: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
