import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import {
  buildOrchestrationPathBody,
  EMPTY_ORCHESTRATION_PATH,
  extractServiceOrchestrationSpecs,
  findServiceId,
  parseCatchAll,
  parseOrchestrationSets,
  type LiveOrchestrationPath,
  type LiveServiceRef,
} from './_shared'

/** Per-service rollback record captured during deploy. */
export interface ServiceOrchestrationRollbackEntry {
  service: string
  serviceId: string
  /** The service's orchestration_path before this deploy (PagerDuty's empty baseline if none was configured). */
  priorPath: LiveOrchestrationPath
  /** Whether this Service Orchestration was the active processing path before this deploy. */
  priorActive: boolean
}

/**
 * Deploy a PagerDuty Service Orchestration over the REST API v2. Unlike the other
 * config types in this app, this is a SINGLETON attached to an existing Service —
 * there is no id, create or delete of "the resource" itself, only a whole-content
 * replace:
 *   resolve ref:      GET  /services                                       → service NAME → id
 *   read (rollback):  GET  /event_orchestrations/services/{id}              → prior sets/catch_all (404 = none configured yet)
 *   read (rollback):  GET  /event_orchestrations/services/{id}/active       → prior active flag (404 = false)
 *   apply:            PUT  /event_orchestrations/services/{id}              with { orchestration_path: {...} }
 *   apply:            PUT  /event_orchestrations/services/{id}/active       with { active: boolean }
 *
 * Reconciliation is per-service: at most one item should target a given service
 * (the canvas identity is the service name). rollbackData records, per service,
 * the exact prior orchestration_path and active flag read immediately before this
 * deploy overwrote them — a service with nothing configured yet rolls back to
 * PagerDuty's own empty baseline ({ sets: [{ id: "start", rules: [] }], catch_all:
 * { actions: {} } }) and an inactive flag, rather than being left half-migrated.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractServiceOrchestrationSpecs(ctx.canvas).filter((s) => s.service && s.setsJson.trim())
  const rollbackState: ServiceOrchestrationRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const services = await listServices(client)

    for (const spec of specs) {
      const serviceId = findServiceId(services, spec.service)
      if (!serviceId) {
        throw new Error(`Service orchestration references service "${spec.service}" which was not found in the account`)
      }

      const parsedSets = parseOrchestrationSets(spec.setsJson)
      if (parsedSets.error || !parsedSets.sets) {
        throw new Error(`Service orchestration for "${spec.service}" has invalid sets: ${parsedSets.error ?? 'unknown'}`)
      }
      const parsedCatchAll = parseCatchAll(spec.catchAllJson)
      if (parsedCatchAll.error || !parsedCatchAll.catchAll) {
        throw new Error(`Service orchestration for "${spec.service}" has an invalid catch_all: ${parsedCatchAll.error ?? 'unknown'}`)
      }

      const priorPath = await getServiceOrchestrationPath(client, serviceId, spec.service)
      const priorActive = await getServiceOrchestrationActive(client, serviceId, spec.service)

      const body = buildOrchestrationPathBody(parsedSets.sets, parsedCatchAll.catchAll)
      const putRes = await client.request('PUT', `/event_orchestrations/services/${encodeURIComponent(serviceId)}`, { body })
      if (!putRes.ok) {
        throw new Error(`Failed to update service orchestration for "${spec.service}": ${pagerDutyErrorMessage(putRes)}`)
      }

      const activeRes = await client.request('PUT', `/event_orchestrations/services/${encodeURIComponent(serviceId)}/active`, {
        body: { active: spec.active },
      })
      if (!activeRes.ok) {
        throw new Error(`Failed to set active state for service orchestration "${spec.service}": ${pagerDutyErrorMessage(activeRes)}`)
      }

      rollbackState.push({ service: spec.service, serviceId, priorPath, priorActive })
      deployed.push(spec.service)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} service orchestration(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Service orchestration deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List all services in the account; throws on a non-OK response. */
export async function listServices(client: PagerDutyClient): Promise<LiveServiceRef[]> {
  const res = await client.getAll<LiveServiceRef>('/services', 'services')
  if (!res.ok) {
    throw new Error(`Failed to list services: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/**
 * GET a service's current orchestration_path. A 404 means the service has no
 * Service Orchestration configured yet — that is treated as PagerDuty's own empty
 * baseline, not an error.
 */
export async function getServiceOrchestrationPath(
  client: PagerDutyClient,
  serviceId: string,
  serviceName: string,
): Promise<LiveOrchestrationPath> {
  const res = await client.request('GET', `/event_orchestrations/services/${encodeURIComponent(serviceId)}`)
  if (res.status === 404) return EMPTY_ORCHESTRATION_PATH
  if (!res.ok) {
    throw new Error(`Failed to read the current orchestration for service "${serviceName}": ${pagerDutyErrorMessage(res)}`)
  }
  return parseJson<{ orchestration_path?: LiveOrchestrationPath }>(res.body)?.orchestration_path ?? EMPTY_ORCHESTRATION_PATH
}

/**
 * GET whether a service's Service Orchestration is currently the active
 * processing path. A 404 (no Service Orchestration configured yet) defaults to
 * `false`.
 */
export async function getServiceOrchestrationActive(
  client: PagerDutyClient,
  serviceId: string,
  serviceName: string,
): Promise<boolean> {
  const res = await client.request('GET', `/event_orchestrations/services/${encodeURIComponent(serviceId)}/active`)
  if (res.status === 404) return false
  if (!res.ok) {
    throw new Error(`Failed to read the active state for service orchestration "${serviceName}": ${pagerDutyErrorMessage(res)}`)
  }
  return Boolean(parseJson<{ active?: boolean }>(res.body)?.active)
}
