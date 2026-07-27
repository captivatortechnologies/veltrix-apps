import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractNpaObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type NetskopeClient,
} from '../../lib/netskope'
import type { LiveLabel } from '../rbac-labels/validate'
import { extractLocalBrokerSpecs, liveLocalBrokerId, type LiveLocalBroker, type LocalBrokerSpec } from './validate'

const BASE = '/infrastructure/lbrokers'
const LIST_KEY = 'lbrokers'
const LABELS_BASE = '/rbac/labels'

export interface LocalBrokerSnapshot {
  local_broker_name: string
  access_via_public_ip: string
  custom_private_ip: string
  custom_public_ip: string
  label_ids: string[]
  latitude?: number
  longitude?: number
  city_name: string
  region_name: string
  country_name: string
  country_code: string
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: LocalBrokerSnapshot
}

export function localBrokerBody(spec: LocalBrokerSpec, labelIds: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    local_broker_name: spec.name,
    access_via_public_ip: spec.accessViaPublicIp,
    custom_private_ip: spec.customPrivateIp,
    custom_public_ip: spec.customPublicIp,
    label_ids: labelIds,
    city_name: spec.cityName,
    region_name: spec.regionName,
    country_name: spec.countryName,
    country_code: spec.countryCode,
  }
  if (spec.latitude !== undefined) body.latitude = spec.latitude
  if (spec.longitude !== undefined) body.longitude = spec.longitude
  return body
}

function snapshotLive(live: LiveLocalBroker): LocalBrokerSnapshot {
  const snap: LocalBrokerSnapshot = {
    local_broker_name: live.local_broker_name ?? '',
    access_via_public_ip: live.access_via_public_ip ?? 'NONE',
    custom_private_ip: live.custom_private_ip ?? '',
    custom_public_ip: live.custom_public_ip ?? '',
    label_ids: (live.label_ids ?? []).map((v) => String(v)),
    city_name: live.city_name ?? '',
    region_name: live.region_name ?? '',
    country_name: live.country_name ?? '',
    country_code: live.country_code ?? '',
  }
  if (typeof live.latitude === 'number') snap.latitude = live.latitude
  if (typeof live.longitude === 'number') snap.longitude = live.longitude
  return snap
}

function resolveLabels(
  entries: string[],
  byName: Map<string, string>,
  byId: Set<string>
): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = []
  const unresolved: string[] = []
  for (const entry of entries) {
    const id = byId.has(entry) ? entry : byName.get(entry.toLowerCase())
    if (id) resolved.push(id)
    else unresolved.push(entry)
  }
  return { resolved, unresolved }
}

async function loadLabelMaps(client: NetskopeClient): Promise<{ ok: boolean; byName: Map<string, string>; byId: Set<string>; error?: string }> {
  const byName = new Map<string, string>()
  const byId = new Set<string>()
  const listed = await client.getAll<LiveLabel>(LABELS_BASE)
  if (!listed.ok) return { ok: false, byName, byId, error: netskopeErrorMessage(listed.lastError!) }
  for (const l of listed.items) {
    if (l.id === undefined || l.id === null) continue
    const id = String(l.id)
    byId.add(id)
    if (l.name) byName.set(l.name.toLowerCase(), id)
  }
  return { ok: true, byName, byId }
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

  const specs = extractLocalBrokerSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAllNpa<LiveLocalBroker>(BASE, LIST_KEY)
  if (!listed.ok) return { success: false, message: `Failed to list NPA local brokers: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveLocalBroker>()
  const liveById = new Map<string, LiveLocalBroker>()
  for (const b of listed.items) {
    if (b.local_broker_name) liveByName.set(b.local_broker_name.toLowerCase(), b)
    const id = liveLocalBrokerId(b)
    if (id) liveById.set(id, b)
  }

  const labelMaps = await loadLabelMaps(client)
  if (!labelMaps.ok) return { success: false, message: `Failed to list RBAC labels: ${labelMaps.error}` }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const { resolved, unresolved } = resolveLabels(spec.labels, labelMaps.byName, labelMaps.byId)
    if (unresolved.length) {
      failures.push(`${spec.name}: unknown RBAC label(s): ${unresolved.join(', ')}`)
      continue
    }

    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveLocalBrokerId(live) : undefined

    if (liveId) {
      const resp = await client.put(`${BASE}/${liveId}`, localBrokerBody(spec, resolved))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, localBrokerBody(spec, resolved))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractNpaObject<LiveLocalBroker>(resp.body)
      const newId = created ? liveLocalBrokerId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete local brokers THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some NPA local brokers failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} NPA local broker(s)`, rollbackData: { entries } }
}
