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
import { extractBandwidthConfigSpecs, type BandwidthConfigSpec, type LiveBandwidthConfig } from './validate'

const PATH = '/bandwidth_manager/configurations'

export interface BandwidthConfigState {
  name: string
  hostname: string
  host_id: number
  kb_limit?: number
  device_name: string
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: number
  prior?: BandwidthConfigState
}

export async function listBandwidthConfigs(client: QRadarClient): Promise<LiveBandwidthConfig[]> {
  const res = await client.request('GET', PATH, { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveBandwidthConfig[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

function bodyOf(spec: BandwidthConfigSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, host_id: spec.hostId, hostname: spec.hostname, device_name: spec.deviceName }
  if (spec.kbLimit !== undefined) body.kb_limit = spec.kbLimit
  return body
}

function stateOf(live: LiveBandwidthConfig): BandwidthConfigState {
  return { name: live.name ?? '', hostname: live.hostname ?? '', host_id: live.host_id ?? -1, kb_limit: live.kb_limit, device_name: live.device_name ?? '' }
}

export function bodyFromState(state: BandwidthConfigState): Record<string, unknown> {
  const body: Record<string, unknown> = { name: state.name, host_id: state.host_id, hostname: state.hostname, device_name: state.device_name }
  if (state.kb_limit !== undefined) body.kb_limit = state.kb_limit
  return body
}

function differs(state: BandwidthConfigState, spec: BandwidthConfigSpec): boolean {
  return (
    state.name !== spec.name ||
    state.hostname !== spec.hostname ||
    state.host_id !== spec.hostId ||
    (state.kb_limit ?? undefined) !== spec.kbLimit ||
    state.device_name !== spec.deviceName
  )
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

  const specs = extractBandwidthConfigSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId as string, p]))
  const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

  const live = await listBandwidthConfigs(client)
  const byId = new Map(live.filter((c) => typeof c.id === 'number').map((c) => [c.id as number, c]))
  const byName = new Map(live.filter((c) => c.name).map((c) => [String(c.name).toLowerCase(), c]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItem.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const existing = (priorEntry?.id !== undefined && byId.get(priorEntry.id)) || byName.get(spec.name.toLowerCase())

    if (existing && typeof existing.id === 'number') {
      const priorState = stateOf(existing)
      if (differs(priorState, spec)) {
        const resp = await client.request('POST', `${PATH}/${existing.id}`, { body: bodyOf(spec) })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: existing.id, prior: priorState })
    } else {
      const resp = await client.request('POST', PATH, { body: bodyOf(spec) })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveBandwidthConfig>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete configurations THIS app created previously but no longer declares.
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter(Boolean))
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && typeof p.id === 'number' && !(p.itemId && declaredItemIds.has(p.itemId)) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.request('DELETE', `${PATH}/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 204 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some bandwidth configurations failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} bandwidth configuration(s)`, rollbackData: { entries } }
}
