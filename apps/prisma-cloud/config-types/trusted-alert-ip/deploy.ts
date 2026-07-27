import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  parseJson,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type PcClient,
} from '../../lib/prismacloud'
import { extractTrustedAlertIpSpecs, type LiveTrustedAlertIp, type TrustedAlertIpSpec } from './validate'

const BASE = '/allow_list/network'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the entry existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: { name: string; cidrs: Array<{ cidr: string; description?: string }> }
}

export function trustedAlertIpBody(spec: TrustedAlertIpSpec): Record<string, unknown> {
  return {
    name: spec.name,
    cidrs: spec.cidrs.map((c) => (c.description ? { cidr: c.cidr, description: c.description } : { cidr: c.cidr })),
  }
}

async function listTrusted(client: PcClient): Promise<{ ok: boolean; items: LiveTrustedAlertIp[]; err?: string }> {
  const res = await client.get(BASE)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LiveTrustedAlertIp[]>(res.body) ?? [] }
}

function priorCidrs(l: LiveTrustedAlertIp): Array<{ cidr: string; description?: string }> {
  return (l.cidrs ?? []).filter((c) => c.cidr).map((c) => ({ cidr: c.cidr as string, description: c.description }))
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
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildPcClient(cred, settings)

  const specs = extractTrustedAlertIpSpecs(ctx.canvas).filter((s) => s.name && !s.cidrsError && s.cidrs.length > 0)

  const listed = await listTrusted(client)
  if (!listed.ok) return { success: false, message: `Failed to list trusted alert IPs: ${listed.err}` }
  const liveByName = new Map<string, LiveTrustedAlertIp>()
  const liveById = new Map<string, LiveTrustedAlertIp>()
  for (const l of listed.items) {
    if (l.name) liveByName.set(l.name.toLowerCase(), l)
    if (l.uuid) liveById.set(l.uuid, l)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const createdNames: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.uuid) {
      const resp = await client.put(`${BASE}/${live.uuid}`, trustedAlertIpBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.uuid, prior: { name: live.name ?? '', cidrs: priorCidrs(live) } })
    } else {
      const resp = await client.post(BASE, trustedAlertIpBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      createdNames.push(spec.name)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: priorEntry?.id })
    }
  }

  // Resolve ids for freshly-created entries (create returns no usable body).
  if (createdNames.length) {
    const relisted = await listTrusted(client)
    if (relisted.ok) {
      const byName = new Map(relisted.items.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))
      for (const e of entries) {
        if (!e.existed && !e.id) e.id = byName.get(e.name.toLowerCase())?.uuid
      }
    }
  }

  // Reconcile: delete entries THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some trusted alert IPs failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} trusted alert IP(s)`, rollbackData: { entries } }
}
