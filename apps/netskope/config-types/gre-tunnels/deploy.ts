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
import { extractGreTunnelSpecs, liveGreTunnelId, type GreTunnelSpec, type LiveGreTunnel } from './validate'

const BASE = '/steering/gre/tunnels'
const LIST_KEY = 'tunnels'
const POPS_BASE = '/steering/gre/pops'
const POPS_LIST_KEY = 'pops'

interface LivePop {
  name?: string
}

export interface GreTunnelSnapshot {
  site: string
  source_ip: string
  pop_names: string[]
  bandwidth: number
  enabled: boolean
  notes: string
  source_type?: string
  template?: string
  vendor?: string
  options: { xff: { xff_enabled: boolean; xff_ip_list: string[] } }
}

export interface RollbackEntry {
  itemId?: string
  site: string
  existed: boolean
  id?: string
  prior?: GreTunnelSnapshot
}

export function greTunnelBody(spec: GreTunnelSpec): GreTunnelSnapshot {
  const body: GreTunnelSnapshot = {
    site: spec.site,
    source_ip: spec.sourceIp,
    pop_names: spec.popNames,
    bandwidth: spec.bandwidth,
    enabled: spec.enabled,
    notes: spec.notes,
    options: { xff: { xff_enabled: spec.xffEnabled, xff_ip_list: spec.xffIpList } },
  }
  if (spec.sourceType) body.source_type = spec.sourceType
  if (spec.template) body.template = spec.template
  if (spec.vendor) body.vendor = spec.vendor
  return body
}

function snapshotLive(live: LiveGreTunnel): GreTunnelSnapshot {
  const snap: GreTunnelSnapshot = {
    site: live.site ?? '',
    source_ip: live.source_ip ?? '',
    pop_names: live.pop_names ?? [],
    bandwidth: live.bandwidth ?? 1000,
    enabled: live.enabled !== false,
    notes: live.notes ?? '',
    options: {
      xff: {
        xff_enabled: live.options?.xff?.xff_enabled === true,
        xff_ip_list: live.options?.xff?.xff_ip_list ?? [],
      },
    },
  }
  if (live.source_type) snap.source_type = live.source_type
  if (live.template) snap.template = live.template
  if (live.vendor) snap.vendor = live.vendor
  return snap
}

async function loadPopNames(client: NetskopeClient): Promise<Set<string>> {
  const set = new Set<string>()
  const listed = await client.getAllNpa<LivePop>(POPS_BASE, POPS_LIST_KEY)
  if (!listed.ok) return set
  for (const p of listed.items) {
    if (p.name) set.add(p.name.toLowerCase())
  }
  return set
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

  const specs = extractGreTunnelSpecs(ctx.canvas).filter((s) => s.site)

  const listed = await client.getAllNpa<LiveGreTunnel>(BASE, LIST_KEY)
  if (!listed.ok) return { success: false, message: `Failed to list GRE tunnels: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveBySite = new Map<string, LiveGreTunnel>()
  const liveById = new Map<string, LiveGreTunnel>()
  for (const t of listed.items) {
    if (t.site) liveBySite.set(t.site.toLowerCase(), t)
    const id = liveGreTunnelId(t)
    if (id) liveById.set(id, t)
  }

  // POP names are validated against the live GRE POPs when that list is available.
  const popNames = await loadPopNames(client)

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    if (popNames.size > 0) {
      const unknown = spec.popNames.filter((p) => !popNames.has(p.toLowerCase()))
      if (unknown.length) {
        failures.push(`${spec.site}: unknown POP name(s): ${unknown.join(', ')}`)
        continue
      }
    }

    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveBySite.get(spec.site.toLowerCase()) ?? null
    const liveId = live ? liveGreTunnelId(live) : undefined

    if (liveId) {
      const resp = await client.put(`${BASE}/${liveId}`, greTunnelBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.site}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, site: spec.site, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, greTunnelBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.site}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractNpaObject<LiveGreTunnel>(resp.body)
      const newId = created ? liveGreTunnelId(created) : undefined
      entries.push({ itemId: spec.itemId, site: spec.site, existed: false, id: newId })
    }
  }

  // Reconcile: delete GRE tunnels THIS app created previously but no longer declares.
  const declaredSites = new Set(specs.map((s) => s.site.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredSites.has(p.site.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.site}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some GRE tunnels failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} GRE tunnel(s)`, rollbackData: { entries } }
}
