import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractNpaObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { extractRateLimitSpecs, liveRateLimitId, parseJsonObject, type LiveRateLimit, type RateLimitSpec } from './validate'

const BASE = '/aig/ratelimits'

export interface RateLimitSnapshot {
  name: string
  criteria: Record<string, unknown>
  limit: Record<string, unknown>
  appliance_ids: string[]
  response: string
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: RateLimitSnapshot
}

export function rateLimitBody(spec: RateLimitSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    criteria: parseJsonObject(spec.criteriaRaw).value ?? {},
    limit: parseJsonObject(spec.limitRaw).value ?? {},
    appliance_ids: spec.applianceIds,
  }
  if (spec.response) body.response = spec.response
  return body
}

function snapshotLive(live: LiveRateLimit): RateLimitSnapshot {
  return {
    name: live.name ?? '',
    criteria: live.criteria ?? {},
    limit: live.limit ?? {},
    appliance_ids: (live.appliance_ids ?? []).map((v) => String(v)),
    response: live.response ?? '',
  }
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractRateLimitSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveRateLimit>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list rate-limit rules: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveRateLimit>()
  const liveById = new Map<string, LiveRateLimit>()
  for (const r of listed.items) {
    if (r.name) liveByName.set(r.name.toLowerCase(), r)
    const id = liveRateLimitId(r)
    if (id) liveById.set(id, r)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveRateLimitId(live) : undefined

    if (liveId) {
      const resp = await client.put(`${BASE}/${liveId}`, rateLimitBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, rateLimitBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractNpaObject<LiveRateLimit>(resp.body)
      const newId = created ? liveRateLimitId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete rate-limit rules THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some rate-limit rules failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} rate-limit rule(s)`, rollbackData: { entries } }
}
