import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import {
  buildOrchestrationBody,
  buildOrchestrationPathBody,
  extractEventOrchestrationSpecs,
  findTeamId,
  parseCatchAll,
  parseOrchestrationSets,
  type LiveEventOrchestration,
  type LiveOrchestrationPath,
} from './_shared'

/** Per-orchestration rollback record captured during deploy. */
export interface EventOrchestrationRollbackEntry {
  name: string
  existed: boolean
  id?: string
  /** The orchestration's identity fields (name/description/team) before this deploy. */
  priorOrchestration?: LiveEventOrchestration
  /** The Router's orchestration_path before this deploy — always captured when the orchestration pre-existed. */
  priorRouter?: LiveOrchestrationPath
  /** Whether this deploy declared (and therefore may have touched) the Global path. */
  globalDeclared: boolean
  priorGlobal?: LiveOrchestrationPath
  /** Whether this deploy declared (and therefore may have touched) the Unrouted path. */
  unroutedDeclared: boolean
  priorUnrouted?: LiveOrchestrationPath
}

type OrchestrationPathName = 'router' | 'global' | 'unrouted'

/**
 * Deploy PagerDuty Event Orchestrations over the REST API v2:
 *   read (rollback): GET  /event_orchestrations               → find each live orchestration by name
 *   resolve ref:      GET  /teams                               → team NAME → id (only fetched if any item declares one)
 *   create:           POST /event_orchestrations                with { orchestration: {...} }
 *   update:           PUT  /event_orchestrations/{id}            with { orchestration: {...} }
 *   router:           PUT  /event_orchestrations/{id}/router      with { orchestration_path: {...} } (always)
 *   global:           PUT  /event_orchestrations/{id}/global      with { orchestration_path: {...} } (only if declared)
 *   unrouted:         PUT  /event_orchestrations/{id}/unrouted    with { orchestration_path: {...} } (only if declared)
 *
 * The name is the stable identity used to upsert. Router is mandatory; Global and
 * Unrouted are only pushed — and only read for rollback — when their `*_sets`
 * field is non-blank, so an operator who never declares Global/Unrouted leaves
 * that path entirely unmanaged. rollbackData records, per orchestration, whether
 * it existed and the exact prior bodies read via GET immediately before each PUT,
 * so rollback can restore a pre-existing orchestration verbatim or delete one this
 * deploy created (PagerDuty cascades the delete to its Router/Global/Unrouted).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractEventOrchestrationSpecs(ctx.canvas).filter((s) => s.name && s.routerSetsJson.trim())
  const rollbackState: EventOrchestrationRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listOrchestrations(client)
    const byName = new Map(existing.filter((o) => o.name).map((o) => [String(o.name).toLowerCase(), o]))
    const teams = specs.some((s) => s.team) ? await listTeams(client) : []

    for (const spec of specs) {
      const routerSets = parseOrchestrationSets(spec.routerSetsJson)
      if (routerSets.error || !routerSets.sets) {
        throw new Error(`Event orchestration "${spec.name}" has invalid router sets: ${routerSets.error ?? 'unknown'}`)
      }
      const routerCatchAll = parseCatchAll(spec.routerCatchAllJson)
      if (routerCatchAll.error || !routerCatchAll.catchAll) {
        throw new Error(`Event orchestration "${spec.name}" has an invalid router catch_all: ${routerCatchAll.error ?? 'unknown'}`)
      }

      const globalDeclared = spec.globalSetsJson.trim().length > 0
      let globalSets: ReturnType<typeof parseOrchestrationSets> | null = null
      let globalCatchAll: ReturnType<typeof parseCatchAll> | null = null
      if (globalDeclared) {
        globalSets = parseOrchestrationSets(spec.globalSetsJson)
        if (globalSets.error || !globalSets.sets) {
          throw new Error(`Event orchestration "${spec.name}" has invalid global sets: ${globalSets.error ?? 'unknown'}`)
        }
        globalCatchAll = parseCatchAll(spec.globalCatchAllJson)
        if (globalCatchAll.error || !globalCatchAll.catchAll) {
          throw new Error(`Event orchestration "${spec.name}" has an invalid global catch_all: ${globalCatchAll.error ?? 'unknown'}`)
        }
      }

      const unroutedDeclared = spec.unroutedSetsJson.trim().length > 0
      let unroutedSets: ReturnType<typeof parseOrchestrationSets> | null = null
      let unroutedCatchAll: ReturnType<typeof parseCatchAll> | null = null
      if (unroutedDeclared) {
        unroutedSets = parseOrchestrationSets(spec.unroutedSetsJson)
        if (unroutedSets.error || !unroutedSets.sets) {
          throw new Error(`Event orchestration "${spec.name}" has invalid unrouted sets: ${unroutedSets.error ?? 'unknown'}`)
        }
        unroutedCatchAll = parseCatchAll(spec.unroutedCatchAllJson)
        if (unroutedCatchAll.error || !unroutedCatchAll.catchAll) {
          throw new Error(`Event orchestration "${spec.name}" has an invalid unrouted catch_all: ${unroutedCatchAll.error ?? 'unknown'}`)
        }
      }

      let teamId: string | undefined
      if (spec.team) {
        const resolved = findTeamId(teams, spec.team)
        if (!resolved) {
          throw new Error(`Event orchestration "${spec.name}" references team "${spec.team}" which was not found in the account`)
        }
        teamId = resolved
      }

      const live = byName.get(spec.name.toLowerCase())
      const body = { orchestration: buildOrchestrationBody(spec, teamId) }
      let orchestrationId: string
      const existed = Boolean(live?.id)

      if (live?.id) {
        orchestrationId = live.id
        const res = await client.request('PUT', `/event_orchestrations/${encodeURIComponent(orchestrationId)}`, { body })
        if (!res.ok) throw new Error(`Failed to update event orchestration "${spec.name}": ${pagerDutyErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/event_orchestrations', { body })
        if (!res.ok) throw new Error(`Failed to create event orchestration "${spec.name}": ${pagerDutyErrorMessage(res)}`)
        const created = parseJson<{ orchestration?: LiveEventOrchestration }>(res.body)?.orchestration
        if (!created?.id) throw new Error(`Event orchestration "${spec.name}" was created but the API returned no id`)
        orchestrationId = created.id
        createdIds.push(orchestrationId)
      }

      let priorRouter: LiveOrchestrationPath | undefined
      let priorGlobal: LiveOrchestrationPath | undefined
      let priorUnrouted: LiveOrchestrationPath | undefined

      if (existed) {
        priorRouter = await getOrchestrationPath(client, orchestrationId, 'router', spec.name)
        if (globalDeclared) priorGlobal = await getOrchestrationPath(client, orchestrationId, 'global', spec.name)
        if (unroutedDeclared) priorUnrouted = await getOrchestrationPath(client, orchestrationId, 'unrouted', spec.name)
      }

      await putOrchestrationPath(
        client,
        orchestrationId,
        'router',
        buildOrchestrationPathBody(routerSets.sets, routerCatchAll.catchAll),
        spec.name,
      )
      if (globalDeclared && globalSets?.sets && globalCatchAll?.catchAll) {
        await putOrchestrationPath(
          client,
          orchestrationId,
          'global',
          buildOrchestrationPathBody(globalSets.sets, globalCatchAll.catchAll),
          spec.name,
        )
      }
      if (unroutedDeclared && unroutedSets?.sets && unroutedCatchAll?.catchAll) {
        await putOrchestrationPath(
          client,
          orchestrationId,
          'unrouted',
          buildOrchestrationPathBody(unroutedSets.sets, unroutedCatchAll.catchAll),
          spec.name,
        )
      }

      rollbackState.push({
        name: spec.name,
        existed,
        id: orchestrationId,
        priorOrchestration: existed ? live : undefined,
        priorRouter,
        globalDeclared,
        priorGlobal,
        unroutedDeclared,
        priorUnrouted,
      })
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} event orchestration(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Event orchestration deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all event orchestrations in the account; throws on a non-OK response. */
export async function listOrchestrations(client: PagerDutyClient): Promise<LiveEventOrchestration[]> {
  const res = await client.getAll<LiveEventOrchestration>('/event_orchestrations', 'orchestrations')
  if (!res.ok) {
    throw new Error(`Failed to list event orchestrations: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** List all teams (name → id resolution for an orchestration's team reference). */
export async function listTeams(client: PagerDutyClient): Promise<Array<{ id?: string; name?: string }>> {
  const res = await client.getAll<{ id?: string; name?: string }>('/teams', 'teams')
  if (!res.ok) {
    throw new Error(`Failed to list teams: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET one orchestration path (Router/Global/Unrouted); throws on a non-OK response. */
export async function getOrchestrationPath(
  client: PagerDutyClient,
  orchestrationId: string,
  path: OrchestrationPathName,
  orchestrationName: string,
): Promise<LiveOrchestrationPath | undefined> {
  const res = await client.request('GET', `/event_orchestrations/${encodeURIComponent(orchestrationId)}/${path}`)
  if (!res.ok) {
    throw new Error(`Failed to read the ${path} path for event orchestration "${orchestrationName}": ${pagerDutyErrorMessage(res)}`)
  }
  return parseJson<{ orchestration_path?: LiveOrchestrationPath }>(res.body)?.orchestration_path
}

/** PUT one orchestration path (Router/Global/Unrouted); throws on a non-OK response. */
export async function putOrchestrationPath(
  client: PagerDutyClient,
  orchestrationId: string,
  path: OrchestrationPathName,
  body: { orchestration_path: unknown },
  orchestrationName: string,
): Promise<void> {
  const res = await client.request('PUT', `/event_orchestrations/${encodeURIComponent(orchestrationId)}/${path}`, { body })
  if (!res.ok) {
    throw new Error(`Failed to update the ${path} path for event orchestration "${orchestrationName}": ${pagerDutyErrorMessage(res)}`)
  }
}
