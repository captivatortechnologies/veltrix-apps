import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractProfileObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { extractServiceObjectSpecs, isPredefined, liveServiceObjectId, type ServiceObjectSpec, type LiveServiceObject } from './validate'

const BASE = '/profiles/serviceobjects'

export interface ServiceObjectSnapshot {
  name: string
  description: string
  icmp: boolean
  tcp: string[]
  udp: string[]
  tcp_udp: string[]
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: ServiceObjectSnapshot
}

export function serviceObjectBody(spec: ServiceObjectSpec): Record<string, unknown> {
  const protocols: Record<string, unknown> = {}
  if (spec.icmp) protocols.icmp = true
  if (spec.tcp.length) protocols.tcp = spec.tcp
  if (spec.udp.length) protocols.udp = spec.udp
  if (spec.tcpUdp.length) protocols.tcp_udp = spec.tcpUdp
  return { name: spec.name, description: spec.description, protocols }
}

function snapshotLive(live: LiveServiceObject): ServiceObjectSnapshot {
  return {
    name: live.name ?? '',
    description: live.description ?? '',
    icmp: live.protocols?.icmp === true,
    tcp: live.protocols?.tcp ?? [],
    udp: live.protocols?.udp ?? [],
    tcp_udp: live.protocols?.tcp_udp ?? [],
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

  const specs = extractServiceObjectSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveServiceObject>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list service objects: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveServiceObject>()
  const liveById = new Map<string, LiveServiceObject>()
  for (const o of listed.items) {
    if (isPredefined(o)) continue // never a match target — Netskope built-in
    if (o.name) liveByName.set(o.name.toLowerCase(), o)
    const id = liveServiceObjectId(o)
    if (id) liveById.set(id, o)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveServiceObjectId(live) : undefined

    if (liveId) {
      const resp = await client.patch(`${BASE}/${liveId}`, serviceObjectBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, serviceObjectBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractProfileObject<LiveServiceObject>(resp.body)
      const newId = created ? liveServiceObjectId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete service objects THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some service objects failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} service object(s)`, rollbackData: { entries } }
}
