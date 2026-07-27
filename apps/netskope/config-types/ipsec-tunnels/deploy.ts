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
import { extractIpsecTunnelSpecs, liveIpsecTunnelId, type IpsecTunnelSpec, type LiveIpsecTunnel } from './validate'

const BASE = '/steering/ipsec/tunnels'
const LIST_KEY = 'tunnels'
const POPS_BASE = '/steering/ipsec/pops'
const POPS_LIST_KEY = 'pops'

interface LivePop {
  name?: string
}

/** Rollback snapshot — the psk is write-only (never returned), so it is not
 *  captured and cannot be restored for a pre-existing tunnel. */
export interface IpsecTunnelSnapshot {
  site: string
  source_ip: string
  pop_names: string[]
  encryption: string
  bandwidth: number
  enabled: boolean
  notes: string
  source_identity?: string
  source_type?: string
  template?: string
  vendor?: string
  options: { reauth: boolean; rekey: boolean; xff: { enabled: boolean; iplist: string[] } }
}

export interface RollbackEntry {
  itemId?: string
  site: string
  existed: boolean
  id?: string
  prior?: IpsecTunnelSnapshot
}

export function ipsecTunnelBody(spec: IpsecTunnelSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    site: spec.site,
    source_ip: spec.sourceIp,
    pop_names: spec.popNames,
    psk: spec.psk,
    bandwidth: spec.bandwidth,
    enabled: spec.enabled,
    notes: spec.notes,
    options: {
      reauth: spec.reauth,
      rekey: spec.rekey,
      xff: { enabled: spec.xffEnabled, iplist: spec.xffIpList },
    },
  }
  if (spec.encryption) body.encryption = spec.encryption
  if (spec.sourceIdentity) body.source_identity = spec.sourceIdentity
  if (spec.sourceType) body.source_type = spec.sourceType
  if (spec.template) body.template = spec.template
  if (spec.vendor) body.vendor = spec.vendor
  return body
}

function snapshotLive(live: LiveIpsecTunnel): IpsecTunnelSnapshot {
  const snap: IpsecTunnelSnapshot = {
    site: live.site ?? '',
    source_ip: live.source_ip ?? '',
    pop_names: live.pop_names ?? [],
    encryption: live.encryption ?? '',
    bandwidth: live.bandwidth ?? 50,
    enabled: live.enabled !== false,
    notes: live.notes ?? '',
    options: {
      reauth: live.options?.reauth === true,
      rekey: live.options?.rekey === true,
      xff: { enabled: live.options?.xff?.enabled === true, iplist: live.options?.xff?.iplist ?? [] },
    },
  }
  if (live.source_identity) snap.source_identity = live.source_identity
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

  const specs = extractIpsecTunnelSpecs(ctx.canvas).filter((s) => s.site)

  const listed = await client.getAllNpa<LiveIpsecTunnel>(BASE, LIST_KEY)
  if (!listed.ok) return { success: false, message: `Failed to list IPSec tunnels: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveBySite = new Map<string, LiveIpsecTunnel>()
  const liveById = new Map<string, LiveIpsecTunnel>()
  for (const t of listed.items) {
    if (t.site) liveBySite.set(t.site.toLowerCase(), t)
    const id = liveIpsecTunnelId(t)
    if (id) liveById.set(id, t)
  }

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
    const liveId = live ? liveIpsecTunnelId(live) : undefined

    if (liveId) {
      const resp = await client.put(`${BASE}/${liveId}`, ipsecTunnelBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.site}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, site: spec.site, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, ipsecTunnelBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.site}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractNpaObject<LiveIpsecTunnel>(resp.body)
      const newId = created ? liveIpsecTunnelId(created) : undefined
      entries.push({ itemId: spec.itemId, site: spec.site, existed: false, id: newId })
    }
  }

  // Reconcile: delete IPSec tunnels THIS app created previously but no longer declares.
  const declaredSites = new Set(specs.map((s) => s.site.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredSites.has(p.site.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.site}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some IPSec tunnels failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} IPSec tunnel(s)`, rollbackData: { entries } }
}
