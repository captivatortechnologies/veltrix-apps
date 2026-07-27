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
import type { LivePublisher } from '../npa-publishers/validate'
import {
  extractPrivateAppSpecs,
  livePrivateAppId,
  livePrivateAppName,
  type LivePrivateApp,
  type PrivateAppSpec,
} from './validate'

const BASE = '/steering/apps/private'
const LIST_KEY = 'private_apps'
const PUBLISHERS_BASE = '/infrastructure/publishers'

export interface AppPublisher {
  publisher_id: string
  publisher_name: string
}

export interface AppSnapshot {
  app_name: string
  host: string
  protocols: Array<{ type: string; port: string }>
  publishers: AppPublisher[]
  clientless_access: boolean
  use_publisher_dns: boolean
  trust_self_signed_certs: boolean
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: AppSnapshot
}

function buildProtocols(spec: PrivateAppSpec): Array<{ type: string; port: string }> {
  const protocols: Array<{ type: string; port: string }> = []
  if (spec.tcpPorts.length) protocols.push({ type: 'tcp', port: spec.tcpPorts.join(',') })
  if (spec.udpPorts.length) protocols.push({ type: 'udp', port: spec.udpPorts.join(',') })
  return protocols
}

export function buildAppBody(spec: PrivateAppSpec, publishers: AppPublisher[]): Record<string, unknown> {
  return {
    app_name: spec.name,
    host: spec.host,
    protocols: buildProtocols(spec),
    publishers,
    clientless_access: spec.clientlessAccess,
    use_publisher_dns: spec.usePublisherDns,
    trust_self_signed_certs: spec.trustSelfSignedCerts,
  }
}

function snapshotLive(live: LivePrivateApp): AppSnapshot {
  return {
    app_name: livePrivateAppName(live),
    host: live.host ?? '',
    protocols: (live.protocols ?? []).map((p) => ({ type: p.type ?? '', port: p.port ?? '' })),
    publishers: (live.publishers ?? []).map((p) => ({
      publisher_id: p.publisher_id !== undefined ? String(p.publisher_id) : '',
      publisher_name: p.publisher_name ?? '',
    })),
    clientless_access: live.clientless_access === true,
    use_publisher_dns: live.use_publisher_dns === true,
    trust_self_signed_certs: live.trust_self_signed_certs === true,
  }
}

/** Resolve declared publisher names/ids to {publisher_id, publisher_name} using
 *  the live publisher inventory. Returns the resolved list and any that could
 *  not be matched. */
function resolvePublishers(
  entries: string[],
  byName: Map<string, LivePublisher>,
  byId: Map<string, LivePublisher>
): { resolved: AppPublisher[]; unresolved: string[] } {
  const resolved: AppPublisher[] = []
  const unresolved: string[] = []
  for (const entry of entries) {
    const match = byId.get(entry) ?? byName.get(entry.toLowerCase())
    if (match?.publisher_id !== undefined) {
      resolved.push({ publisher_id: String(match.publisher_id), publisher_name: match.publisher_name ?? entry })
    } else {
      unresolved.push(entry)
    }
  }
  return { resolved, unresolved }
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

async function loadPublisherMaps(client: NetskopeClient): Promise<{ ok: boolean; byName: Map<string, LivePublisher>; byId: Map<string, LivePublisher>; error?: string }> {
  const byName = new Map<string, LivePublisher>()
  const byId = new Map<string, LivePublisher>()
  const listed = await client.getAllNpa<LivePublisher>(PUBLISHERS_BASE, 'publishers')
  if (!listed.ok) return { ok: false, byName, byId, error: netskopeErrorMessage(listed.lastError!) }
  for (const p of listed.items) {
    if (p.publisher_name) byName.set(p.publisher_name.toLowerCase(), p)
    if (p.publisher_id !== undefined) byId.set(String(p.publisher_id), p)
  }
  return { ok: true, byName, byId }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractPrivateAppSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAllNpa<LivePrivateApp>(BASE, LIST_KEY)
  if (!listed.ok) return { success: false, message: `Failed to list private apps: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LivePrivateApp>()
  const liveById = new Map<string, LivePrivateApp>()
  for (const a of listed.items) {
    const name = livePrivateAppName(a)
    const id = livePrivateAppId(a)
    if (name) liveByName.set(name.toLowerCase(), a)
    if (id) liveById.set(id, a)
  }

  const pubMaps = await loadPublisherMaps(client)
  if (!pubMaps.ok) return { success: false, message: `Failed to list NPA publishers: ${pubMaps.error}` }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const { resolved, unresolved } = resolvePublishers(spec.publishers, pubMaps.byName, pubMaps.byId)
    if (unresolved.length) {
      failures.push(`${spec.name}: unknown publisher(s): ${unresolved.join(', ')}`)
      continue
    }

    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? livePrivateAppId(live) : undefined

    if (liveId) {
      const resp = await client.put(`${BASE}/${liveId}`, buildAppBody(spec, resolved))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, buildAppBody(spec, resolved))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractNpaObject<LivePrivateApp>(resp.body)
      const newId = created ? livePrivateAppId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete private apps THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some private apps failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} private app(s)`, rollbackData: { entries } }
}
