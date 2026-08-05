import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  parseJson,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type QRadarClient,
} from '../../lib/qradar'
import { indexByLowerName, listEventRetentionBuckets, listFlowRetentionBuckets } from '../../lib/lookups'
import { extractArielCopyProfileSpecs, type ArielCopyProfileSpec, type LiveArielCopyProfile } from './validate'

const PATH = '/disaster_recovery/ariel_copy_profiles'

export interface ProfileState {
  destinationHostIp: string
  destinationPort?: number
  enabled: boolean
  frequency?: number
  bandwidthLimit?: number
  startDate?: number
  endDate?: number
  excludeEventRetentionBucketIds: number[]
  excludeFlowRetentionBucketIds: number[]
}

export interface RollbackEntry {
  itemId?: string
  name: string
  hostId: number
  existed: boolean
  id?: number
  prior?: ProfileState
}

export async function listProfiles(client: QRadarClient): Promise<LiveArielCopyProfile[]> {
  const res = await client.request('GET', PATH, { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveArielCopyProfile[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

function bodyOf(spec: ArielCopyProfileSpec, hostId: number, eventBucketIds: number[], flowBucketIds: number[]): Record<string, unknown> {
  const body: Record<string, unknown> = { host_id: hostId, destination_host_ip: spec.destinationHostIp, enabled: spec.enabled }
  if (spec.destinationPort !== undefined) body.destination_port = spec.destinationPort
  if (spec.frequency !== undefined) body.frequency = spec.frequency
  if (spec.bandwidthLimit !== undefined) body.bandwidth_limit = spec.bandwidthLimit
  if (spec.startDate !== undefined) body.start_date = spec.startDate
  if (spec.endDate !== undefined) body.end_date = spec.endDate
  body.exclude_event_retention_bucket_ids = eventBucketIds
  body.exclude_flow_retention_bucket_ids = flowBucketIds
  return body
}

function stateOf(live: LiveArielCopyProfile): ProfileState {
  return {
    destinationHostIp: live.destination_host_ip ?? '',
    destinationPort: live.destination_port,
    enabled: live.enabled ?? false,
    frequency: live.frequency,
    bandwidthLimit: live.bandwidth_limit,
    startDate: live.start_date,
    endDate: live.end_date,
    excludeEventRetentionBucketIds: live.exclude_event_retention_bucket_ids ?? [],
    excludeFlowRetentionBucketIds: live.exclude_flow_retention_bucket_ids ?? [],
  }
}

function sortedIds(ids: number[]): string {
  return JSON.stringify([...ids].sort((a, b) => a - b))
}

function differs(state: ProfileState, spec: ArielCopyProfileSpec, eventBucketIds: number[], flowBucketIds: number[]): boolean {
  return (
    state.destinationHostIp !== spec.destinationHostIp ||
    (state.destinationPort ?? undefined) !== spec.destinationPort ||
    state.enabled !== spec.enabled ||
    (state.frequency ?? undefined) !== spec.frequency ||
    (state.bandwidthLimit ?? undefined) !== spec.bandwidthLimit ||
    (state.startDate ?? undefined) !== spec.startDate ||
    (state.endDate ?? undefined) !== spec.endDate ||
    sortedIds(state.excludeEventRetentionBucketIds) !== sortedIds(eventBucketIds) ||
    sortedIds(state.excludeFlowRetentionBucketIds) !== sortedIds(flowBucketIds)
  )
}

export function bodyFromState(hostId: number, state: ProfileState): Record<string, unknown> {
  return {
    host_id: hostId,
    destination_host_ip: state.destinationHostIp,
    destination_port: state.destinationPort,
    enabled: state.enabled,
    frequency: state.frequency,
    bandwidth_limit: state.bandwidthLimit,
    start_date: state.startDate,
    end_date: state.endDate,
    exclude_event_retention_bucket_ids: state.excludeEventRetentionBucketIds,
    exclude_flow_retention_bucket_ids: state.excludeFlowRetentionBucketIds,
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
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const specs = extractArielCopyProfileSpecs(ctx.canvas).filter((s) => s.name && s.hostId)
  const prior = await loadPriorEntries(ctx)

  const [eventBuckets, flowBuckets, live] = await Promise.all([
    listEventRetentionBuckets(client),
    listFlowRetentionBuckets(client),
    listProfiles(client),
  ])
  const eventBucketByName = indexByLowerName(eventBuckets)
  const flowBucketByName = indexByLowerName(flowBuckets)
  const byHostId = new Map(live.filter((p) => typeof p.host_id === 'number').map((p) => [p.host_id as number, p]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const eventBucketIds: number[] = []
    let unresolved: string | undefined
    for (const name of spec.excludeEventRetentionBucketNames) {
      const id = eventBucketByName.get(name.toLowerCase())
      if (id === undefined) { unresolved = `unknown event retention bucket "${name}"`; break }
      eventBucketIds.push(id)
    }
    if (unresolved) { failures.push(`${spec.name}: ${unresolved}`); continue }

    const flowBucketIds: number[] = []
    for (const name of spec.excludeFlowRetentionBucketNames) {
      const id = flowBucketByName.get(name.toLowerCase())
      if (id === undefined) { unresolved = `unknown flow retention bucket "${name}"`; break }
      flowBucketIds.push(id)
    }
    if (unresolved) { failures.push(`${spec.name}: ${unresolved}`); continue }

    const existing = byHostId.get(spec.hostId)

    if (existing && typeof existing.id === 'number') {
      const priorState = stateOf(existing)
      if (differs(priorState, spec, eventBucketIds, flowBucketIds)) {
        const resp = await client.request('POST', `${PATH}/${existing.id}`, { body: bodyOf(spec, spec.hostId, eventBucketIds, flowBucketIds) })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, hostId: spec.hostId, existed: true, id: existing.id, prior: priorState })
    } else {
      const resp = await client.request('POST', PATH, { body: bodyOf(spec, spec.hostId, eventBucketIds, flowBucketIds) })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveArielCopyProfile>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, hostId: spec.hostId, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete profiles THIS app created previously but no longer declares.
  const declaredHostIds = new Set(specs.map((s) => s.hostId))
  for (const p of prior) {
    if (!p.existed && typeof p.id === 'number' && !declaredHostIds.has(p.hostId)) {
      const resp = await client.request('DELETE', `${PATH}/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some Ariel Copy Profiles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} Ariel Copy Profile(s)`, rollbackData: { entries } }
}
