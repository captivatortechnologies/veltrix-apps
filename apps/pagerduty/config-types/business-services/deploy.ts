import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import {
  buildBusinessServiceBody,
  extractBusinessServiceSpecs,
  findTeamId,
  type LiveBusinessService,
} from './_shared'

/** Per-business-service rollback record captured during deploy. */
export interface BusinessServiceRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: LiveBusinessService
}

/**
 * Deploy PagerDuty business services over the REST API v2:
 *   read (rollback): GET  /business_services     → find each live item by name
 *   resolve ref:      GET  /teams                  → team NAME → id (when declared)
 *   create:           POST /business_services      with { business_service: {...} }
 *   update:           PUT  /business_services/{id} with { business_service: {...} }
 *
 * The name is the stable identity used to upsert. A business service optionally
 * references a team by name, resolved here to a team reference; the item fails
 * if a declared team name doesn't exist in the account. rollbackData records,
 * per item, whether it existed and its prior body — so rollback can restore an
 * updated item or delete a newly created one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractBusinessServiceSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: BusinessServiceRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listBusinessServices(client)
    const byName = new Map(existing.filter((s) => s.name).map((s) => [String(s.name).toLowerCase(), s]))
    const teams = await listTeams(client)

    for (const spec of specs) {
      let teamId: string | null = null
      if (spec.teamName) {
        teamId = findTeamId(teams, spec.teamName)
        if (!teamId) {
          throw new Error(
            `Business service "${spec.name}" references team "${spec.teamName}" which was not found in the account`,
          )
        }
      }

      const body = { business_service: buildBusinessServiceBody(spec, teamId) }
      const live = byName.get(spec.name.toLowerCase())

      if (live && live.id) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/business_services/${encodeURIComponent(live.id)}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to update business service "${spec.name}": ${pagerDutyErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/business_services', { body })
        if (!res.ok) {
          throw new Error(`Failed to create business service "${spec.name}": ${pagerDutyErrorMessage(res)}`)
        }
        const created = parseJson<{ business_service?: LiveBusinessService }>(res.body)?.business_service
        if (!created?.id) throw new Error(`Business service "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} business service(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Business service deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all business services in the account; throws on a non-OK response. */
export async function listBusinessServices(client: PagerDutyClient): Promise<LiveBusinessService[]> {
  const res = await client.getAll<LiveBusinessService>('/business_services', 'business_services')
  if (!res.ok) {
    throw new Error(
      `Failed to list business services: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** List all teams (name → id resolution for the optional team reference). */
export async function listTeams(client: PagerDutyClient): Promise<Array<{ id?: string; name?: string }>> {
  const res = await client.getAll<{ id?: string; name?: string }>('/teams', 'teams')
  if (!res.ok) {
    throw new Error(`Failed to list teams: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
