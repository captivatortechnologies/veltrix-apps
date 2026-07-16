import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  parseJson,
  type InsightVMClient,
} from '../../lib/insightvm'
import { extractScheduleSpecs, parseScheduleObject, scheduleKey, type LiveSchedule, type ScheduleSpec } from './validate'

export interface ScheduleRollbackEntry {
  key: string
  label: string
  siteId: number
  existed: boolean
  id?: number
  prior?: LiveSchedule
}

/**
 * Deploy Rapid7 InsightVM per-site scan schedules. Each schedule is a child of a
 * site: the handler resolves the site by name, lists its schedules, matches by
 * schedule name (stored as scanName), then POSTs a new schedule or PUTs an
 * existing one. Identity is (site name, schedule name).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractScheduleSpecs(ctx.canvas).filter((s) => s.siteName && s.scheduleName)
  const rollbackState: ScheduleRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const siteIds = new Map<string, number>()

    for (const spec of specs) {
      const label = `${spec.scheduleName} @ ${spec.siteName}`
      const siteId = await resolveSiteId(client, spec.siteName, siteIds)

      const existing = await listSchedules(client, siteId)
      const live = existing.find((s) => s.scanName === spec.scheduleName)
      const key = scheduleKey(spec)

      if (live && live.id != null) {
        rollbackState.push({ key, label, siteId, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/scan_schedules/${live.id}`, { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to update schedule "${label}": ${insightVMErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', `/sites/${siteId}/scan_schedules`, { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to create schedule "${label}": ${insightVMErrorMessage(res)}`)
        const created = parseJson<{ id?: number }>(res.body)
        if (created?.id == null) throw new Error(`Schedule "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, siteId, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} scan schedule(s) to ${consoleUrl}: ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedSchedules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scan schedule deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedSchedules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

interface LiveSite {
  id?: number
  name?: string
}

/** Resolve a site name to its id (cached); throws when the site is not found. */
export async function resolveSiteId(client: InsightVMClient, name: string, cache: Map<string, number>): Promise<number> {
  const cached = cache.get(name.toLowerCase())
  if (cached !== undefined) return cached
  const res = await client.getAll<LiveSite>('/sites')
  if (!res.ok) {
    throw new Error(`Failed to list sites while resolving "${name}": ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  for (const site of res.items) {
    if (site.name && site.id != null) cache.set(site.name.toLowerCase(), site.id)
  }
  const id = cache.get(name.toLowerCase())
  if (id === undefined) throw new Error(`Site "${name}" not found — create the site before scheduling scans on it`)
  return id
}

/** List a site's scan schedules; throws on a non-OK response. */
export async function listSchedules(client: InsightVMClient, siteId: number): Promise<LiveSchedule[]> {
  const res = await client.getAll<LiveSchedule>(`/sites/${siteId}/scan_schedules`)
  if (!res.ok) {
    throw new Error(`Failed to list scan schedules for site ${siteId}: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

function buildBody(spec: ScheduleSpec): Record<string, unknown> {
  const details = parseScheduleObject(spec.scheduleJson).value ?? {}
  // The schedule name is carried as scanName; enabled + schedule details merge on top.
  return { scanName: spec.scheduleName, enabled: spec.enabled, ...details }
}
