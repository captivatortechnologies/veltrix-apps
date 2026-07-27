import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import {
  createFileVantage,
  updateFileVantage,
  type FileVantageEndpoints,
} from '../../lib/filevantageAdapter'
import {
  extractScheduledExclusionSpecs,
  scopeString,
  type LiveScheduledExclusion,
  type ScheduledExclusionSpec,
} from './validate'

/**
 * Paths for the FileVantage Scheduled Exclusions API surface. Unlike the other
 * FileVantage families, both the query and get endpoints REQUIRE the parent
 * `policy_id`, and the query supports no filter/limit/offset — so lookup is done
 * with direct client calls here rather than the bare adapter find/get.
 */
export const SCHEDULED_EXCLUSION_ENDPOINTS: FileVantageEndpoints = {
  entity: '/filevantage/entities/policy-scheduled-exclusions/v1',
  queries: '/filevantage/queries/policy-scheduled-exclusions/v1',
}

/** Scheduled-exclusion fields this app manages and can restore on rollback. */
export interface ScheduledExclusionRollbackEntry {
  name: string
  policyId: string
  existed: boolean
  id?: string
  prior?: {
    description?: string
    timezone?: string
    schedule_start?: string
    schedule_end?: string
    processes?: string
    users?: string
    repeated?: LiveScheduledExclusion['repeated']
  }
}

/**
 * Deploy FileVantage scheduled exclusions to a Falcon tenant.
 *
 * For each declared exclusion (identified by name WITHIN its policy):
 *   - list the policy's exclusions and match on name — find it
 *   - if it exists, PATCH the managed fields (create/update carry policy_id in
 *     the body)
 *   - otherwise POST a new exclusion
 *
 * Prior state is captured so rollback can revert updates and delete anything
 * this deploy created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractScheduledExclusionSpecs(ctx.canvas).filter((s) => s.name && s.policyId)
  const rollbackState: ScheduledExclusionRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findScheduledExclusionByName(client, spec.policyId, spec.name)

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          policyId: spec.policyId,
          existed: true,
          id: existing.id,
          prior: {
            description: existing.description,
            timezone: existing.timezone,
            schedule_start: existing.schedule_start,
            schedule_end: existing.schedule_end,
            processes: existing.processes,
            users: existing.users,
            repeated: existing.repeated,
          },
        })

        await updateFileVantage(client, SCHEDULED_EXCLUSION_ENDPOINTS, {
          id: existing.id,
          ...buildExclusionBody(spec),
        })
      } else {
        const id = await createFileVantage(
          client,
          SCHEDULED_EXCLUSION_ENDPOINTS,
          buildExclusionBody(spec),
        )
        rollbackState.push({ name: spec.name, policyId: spec.policyId, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} FileVantage scheduled exclusion(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedExclusions: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scheduled exclusion deployment failed after ${deployed.length} of ${specs.length} exclusion(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedExclusions: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Transport that needs policy_id (query/get/delete) ------------------------

/** Fetch full scheduled-exclusion entities — requires BOTH policy_id and ids. */
export async function getScheduledExclusions(
  client: FalconClient,
  policyId: string,
  ids: string[],
): Promise<LiveScheduledExclusion[]> {
  if (ids.length === 0) return []
  // GET entities requires policy_id AND ids; FalconClient can't repeat the `ids`
  // key, so the id list is encoded directly into the request path.
  const path = `${SCHEDULED_EXCLUSION_ENDPOINTS.entity}?policy_id=${encodeURIComponent(policyId)}${ids
    .map((id) => `&ids=${encodeURIComponent(id)}`)
    .join('')}`
  const res = await client.request('GET', path)
  if (!res.ok) throw new Error(`Failed to load scheduled exclusions: ${falconErrorMessage(res)}`)
  return parseEnvelope<LiveScheduledExclusion>(res.body)?.resources ?? []
}

/**
 * Find a scheduled exclusion by name within its policy. The query endpoint takes
 * only policy_id (no filter/limit/offset) and returns EVERY exclusion id in the
 * policy, so the name is pinned client-side (a single unambiguous
 * case-insensitive match is tolerated). Returns null when none matches.
 */
export async function findScheduledExclusionByName(
  client: FalconClient,
  policyId: string,
  name: string,
): Promise<LiveScheduledExclusion | null> {
  const queryRes = await client.request('GET', SCHEDULED_EXCLUSION_ENDPOINTS.queries, {
    query: { policy_id: policyId },
  })
  if (!queryRes.ok) {
    throw new Error(
      `Failed to list scheduled exclusions for policy ${policyId}: ${falconErrorMessage(queryRes)}`,
    )
  }
  const ids = (parseEnvelope<string>(queryRes.body)?.resources ?? []).filter(
    (id): id is string => typeof id === 'string',
  )
  if (ids.length === 0) return null

  const entities = await getScheduledExclusions(client, policyId, ids)
  const exact = entities.find((e) => e.name === name)
  if (exact) return exact
  const caseInsensitive = entities.filter((e) => e.name?.toLowerCase() === name.toLowerCase())
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

/** Delete a scheduled exclusion by id — requires policy_id alongside the id. */
export async function deleteScheduledExclusion(
  client: FalconClient,
  policyId: string,
  id: string,
): Promise<void> {
  const path = `${SCHEDULED_EXCLUSION_ENDPOINTS.entity}?policy_id=${encodeURIComponent(
    policyId,
  )}&ids=${encodeURIComponent(id)}`
  const res = await client.request('DELETE', path)
  const failure = res.status === 404 ? null : falconFailure(res)
  if (failure) throw new Error(`Failed to delete scheduled exclusion: ${failure}`)
}

// --- Body building ------------------------------------------------------------

/** Build the API body from a spec (create and update share the same shape). */
export function buildExclusionBody(spec: ScheduledExclusionSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    policy_id: spec.policyId,
    timezone: spec.timezone,
    schedule_start: spec.scheduleStart,
    processes: scopeString(spec.processes),
    users: scopeString(spec.users),
  }
  if (spec.description) body.description = spec.description
  if (spec.scheduleEnd) body.schedule_end = spec.scheduleEnd
  if (spec.recurrence !== 'never') body.repeated = buildRepeated(spec)
  return body
}

/** Build the API's `repeated` recurrence object; only sent when recurring. */
export function buildRepeated(spec: ScheduledExclusionSpec): Record<string, unknown> {
  const repeated: Record<string, unknown> = {
    frequency: spec.recurrence,
    all_day: spec.allDay,
  }
  if (!spec.allDay) {
    if (spec.startTime) repeated.start_time = spec.startTime
    if (spec.endTime) repeated.end_time = spec.endTime
  }
  if (spec.recurrence === 'weekly') repeated.weekly_days = spec.weeklyDays
  if (spec.recurrence === 'monthly') repeated.monthly_days = spec.monthlyDays.map((d) => Number(d))
  return repeated
}
