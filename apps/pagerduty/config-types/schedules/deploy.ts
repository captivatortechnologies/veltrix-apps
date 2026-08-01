import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import {
  buildScheduleBody,
  extractScheduleSpecs,
  parseScheduleLayers,
  type LiveSchedule,
} from './_shared'

/** Per-schedule rollback record captured during deploy. */
export interface ScheduleRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: LiveSchedule
}

/**
 * Deploy PagerDuty on-call schedules over the REST API v2:
 *   read (rollback): GET  /schedules          → find each live schedule by name
 *   create:          POST /schedules           with { schedule: {...} }
 *   update:          PUT  /schedules/{id}       with { schedule: {...} }
 *
 * The name is the stable identity used to upsert. rollbackData records, per
 * schedule, whether it existed and its prior body — so rollback can restore an
 * updated schedule or delete a newly created one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractScheduleSpecs(ctx.canvas).filter((s) => s.name && s.timeZone && s.layersJson.trim())
  const rollbackState: ScheduleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listSchedules(client)
    const byName = new Map(existing.filter((s) => s.name).map((s) => [String(s.name).toLowerCase(), s]))

    for (const spec of specs) {
      const parsed = parseScheduleLayers(spec.layersJson)
      if (parsed.error || !parsed.layers) {
        throw new Error(`Schedule "${spec.name}" has invalid layers: ${parsed.error ?? 'unknown'}`)
      }
      const body = { schedule: buildScheduleBody(spec, parsed.layers) }
      const live = byName.get(spec.name.toLowerCase())

      if (live && live.id) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/schedules/${encodeURIComponent(live.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to update schedule "${spec.name}": ${pagerDutyErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/schedules', { body })
        if (!res.ok) throw new Error(`Failed to create schedule "${spec.name}": ${pagerDutyErrorMessage(res)}`)
        const created = parseJson<{ schedule?: LiveSchedule }>(res.body)?.schedule
        if (!created?.id) throw new Error(`Schedule "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} schedule(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Schedule deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all schedules in the account; throws on a non-OK response. */
export async function listSchedules(client: PagerDutyClient): Promise<LiveSchedule[]> {
  const res = await client.getAll<LiveSchedule>('/schedules', 'schedules')
  if (!res.ok) {
    throw new Error(`Failed to list schedules: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
