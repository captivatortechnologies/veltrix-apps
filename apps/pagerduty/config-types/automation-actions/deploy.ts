import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import {
  buildActionBody,
  extractAutomationActionSpecs,
  findAutomationAction,
  findRunnerId,
  findServiceId,
  findTeamId,
  liveServiceIds,
  liveTeamIds,
  parseActionData,
  parseNameList,
  VALID_ACTION_TYPES,
  type LiveAutomationAction,
} from './_shared'

const MAX_NAMES_LISTED = 10

/** Per-action rollback record captured during deploy. */
export interface AutomationActionRollbackEntry {
  name: string
  existed: boolean
  id?: string
  /** Full live shape read BEFORE this deploy touched it — undefined for a brand-new action. */
  prior?: LiveAutomationAction
  /** Team/service ids THIS deploy newly associated — the only ones rollback removes. */
  addedTeamIds: string[]
  addedServiceIds: string[]
}

function listAvailable(names: Array<string | undefined>): string {
  const available = names.filter((n): n is string => Boolean(n))
  const shown = available.slice(0, MAX_NAMES_LISTED).join(', ')
  const suffix = available.length > MAX_NAMES_LISTED ? `, and ${available.length - MAX_NAMES_LISTED} more` : ''
  return `${shown || '(none)'}${suffix}`
}

/**
 * Deploy PagerDuty Automation Actions over the REST API v2:
 *   read (rollback):  GET  /automation_actions/actions            → find each live action by name
 *   resolve runner:    GET  /automation_actions/runners            → runner NAME → id (when declared)
 *   resolve teams:     GET  /teams                                 → each team NAME → id (when declared)
 *   resolve services:  GET  /services                              → each service NAME → id (when declared)
 *   create:            POST /automation_actions/actions            with { action: {...} }
 *   update:            PUT  /automation_actions/actions/{id}       with { action: {...} }
 *   associate team:    POST /automation_actions/actions/{id}/teams    with { team: { id, type } }
 *   associate service: POST /automation_actions/actions/{id}/services with { service: { id, type } }
 *
 * The name is the stable identity used to upsert. `action_type` is immutable
 * once PagerDuty sets it — a redeploy that tries to change it on an existing
 * action fails with a clear error rather than silently delete+recreate (which
 * would orphan any Event Orchestration rule or extension referencing the old
 * action id). Team/service associations are ADDITIVE ONLY (see _shared.ts):
 * this deploy attaches every declared name not already attached, and never
 * detaches one that was removed from the canvas.
 *
 * rollbackData records, per action, whether it existed, its prior full body
 * (read via a defensive GET-by-id — the list response may not embed full
 * team/service detail) and exactly which associations THIS deploy added.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractAutomationActionSpecs(ctx.canvas).filter(
    (s) => s.name && s.description && VALID_ACTION_TYPES.has(s.actionType),
  )
  const rollbackState: AutomationActionRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listAutomationActions(client)
    const byName = new Map(existing.filter((a) => a.name).map((a) => [String(a.name).toLowerCase(), a]))

    const needsRunner = specs.some((s) => s.runnerName)
    const needsTeams = specs.some((s) => parseNameList(s.teamsJson, 'team').names?.length)
    const needsServices = specs.some((s) => !s.mapToAllServices && parseNameList(s.servicesJson, 'service').names?.length)
    const runners = needsRunner ? await listAutomationActionRunners(client) : []
    const teams = needsTeams ? await listTeams(client) : []
    const services = needsServices ? await listServices(client) : []

    for (const spec of specs) {
      const dataParsed = parseActionData(spec.actionDataJson, spec.actionType)
      if (dataParsed.error || !dataParsed.data) {
        throw new Error(`Automation action "${spec.name}" has invalid action_data: ${dataParsed.error ?? 'unknown'}`)
      }

      let runnerId: string | null = null
      if (spec.runnerName) {
        runnerId = findRunnerId(runners, spec.runnerName)
        if (!runnerId) {
          throw new Error(
            `Automation action "${spec.name}" references runner "${spec.runnerName}" which was not found in the account. Available runners: ${listAvailable(runners.map((r) => r.name))}`,
          )
        }
      }

      const teamNamesParsed = parseNameList(spec.teamsJson, 'team')
      if (teamNamesParsed.error || !teamNamesParsed.names) {
        throw new Error(`Automation action "${spec.name}" has invalid teams: ${teamNamesParsed.error ?? 'unknown'}`)
      }
      const desiredTeamIds: string[] = []
      for (const teamName of teamNamesParsed.names) {
        const teamId = findTeamId(teams, teamName)
        if (!teamId) {
          throw new Error(`Automation action "${spec.name}" references team "${teamName}" which was not found in the account`)
        }
        desiredTeamIds.push(teamId)
      }

      let desiredServiceIds: string[] = []
      if (!spec.mapToAllServices) {
        const serviceNamesParsed = parseNameList(spec.servicesJson, 'service')
        if (serviceNamesParsed.error || !serviceNamesParsed.names) {
          throw new Error(`Automation action "${spec.name}" has invalid services: ${serviceNamesParsed.error ?? 'unknown'}`)
        }
        for (const serviceName of serviceNamesParsed.names) {
          const serviceId = findServiceId(services, serviceName)
          if (!serviceId) {
            throw new Error(`Automation action "${spec.name}" references service "${serviceName}" which was not found in the account`)
          }
          desiredServiceIds.push(serviceId)
        }
      }

      const body = { action: buildActionBody(spec, dataParsed.data, runnerId) }
      const live = byName.get(spec.name.toLowerCase())

      let actionId: string
      let existed: boolean
      let prior: LiveAutomationAction | undefined
      let currentTeamIds = new Set<string>()
      let currentServiceIds = new Set<string>()

      if (live?.id) {
        if (live.action_type && live.action_type !== spec.actionType) {
          throw new Error(
            `Automation action "${spec.name}" already exists with action_type "${live.action_type}", which PagerDuty does not allow changing to "${spec.actionType}" once set — delete the existing action in PagerDuty (or declare this item under a new name) to recreate it with the new type.`,
          )
        }

        const shown = await getAutomationAction(client, live.id)
        prior = shown ?? live
        currentTeamIds = liveTeamIds(prior)
        currentServiceIds = liveServiceIds(prior)

        actionId = live.id
        existed = true
        const res = await client.request('PUT', `/automation_actions/actions/${encodeURIComponent(actionId)}`, { body })
        if (!res.ok) throw new Error(`Failed to update automation action "${spec.name}": ${pagerDutyErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/automation_actions/actions', { body })
        if (!res.ok) throw new Error(`Failed to create automation action "${spec.name}": ${pagerDutyErrorMessage(res)}`)
        const created = parseJson<{ action?: LiveAutomationAction }>(res.body)?.action
        if (!created?.id) throw new Error(`Automation action "${spec.name}" was created but the API returned no id`)
        actionId = created.id
        existed = false
        createdIds.push(actionId)
      }

      const addedTeamIds: string[] = []
      for (const teamId of desiredTeamIds) {
        if (currentTeamIds.has(teamId)) continue
        const res = await client.request('POST', `/automation_actions/actions/${encodeURIComponent(actionId)}/teams`, {
          body: { team: { id: teamId, type: 'team_reference' } },
        })
        if (!res.ok) {
          throw new Error(`Failed to associate automation action "${spec.name}" with team "${teamId}": ${pagerDutyErrorMessage(res)}`)
        }
        addedTeamIds.push(teamId)
      }

      const addedServiceIds: string[] = []
      for (const serviceId of desiredServiceIds) {
        if (currentServiceIds.has(serviceId)) continue
        const res = await client.request('POST', `/automation_actions/actions/${encodeURIComponent(actionId)}/services`, {
          body: { service: { id: serviceId, type: 'service_reference' } },
        })
        if (!res.ok) {
          throw new Error(`Failed to associate automation action "${spec.name}" with service "${serviceId}": ${pagerDutyErrorMessage(res)}`)
        }
        addedServiceIds.push(serviceId)
      }

      rollbackState.push({ name: spec.name, existed, id: actionId, prior, addedTeamIds, addedServiceIds })
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} automation action(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Automation action deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all automation actions in the account (cursor-paginated); throws on a non-OK response. */
export async function listAutomationActions(client: PagerDutyClient): Promise<LiveAutomationAction[]> {
  const res = await client.getAllCursor<LiveAutomationAction>('/automation_actions/actions', 'actions')
  if (!res.ok) {
    throw new Error(
      `Failed to list automation actions: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/**
 * Read one action by id — a defensive re-fetch: the list response may not embed
 * full team/service detail, so this is used before diffing associations.
 * Returns null (never throws) on a non-OK response; callers fall back to the
 * list-response object.
 */
export async function getAutomationAction(client: PagerDutyClient, id: string): Promise<LiveAutomationAction | null> {
  const res = await client.request('GET', `/automation_actions/actions/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  return parseJson<{ action?: LiveAutomationAction }>(res.body)?.action ?? null
}

/** List all automation action runners (cursor-paginated) — runner NAME → id resolution only; not managed here. */
export async function listAutomationActionRunners(
  client: PagerDutyClient,
): Promise<Array<{ id?: string; name?: string }>> {
  const res = await client.getAllCursor<{ id?: string; name?: string }>('/automation_actions/runners', 'runners')
  if (!res.ok) {
    throw new Error(
      `Failed to list automation action runners: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** List all teams (team NAME → id resolution for an association). */
export async function listTeams(client: PagerDutyClient): Promise<Array<{ id?: string; name?: string }>> {
  const res = await client.getAll<{ id?: string; name?: string }>('/teams', 'teams')
  if (!res.ok) {
    throw new Error(`Failed to list teams: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** List all services (service NAME → id resolution for an association). */
export async function listServices(client: PagerDutyClient): Promise<Array<{ id?: string; name?: string }>> {
  const res = await client.getAll<{ id?: string; name?: string }>('/services', 'services')
  if (!res.ok) {
    throw new Error(`Failed to list services: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
