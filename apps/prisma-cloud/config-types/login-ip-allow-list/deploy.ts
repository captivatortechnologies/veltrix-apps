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
import { extractLoginIpAllowSpecs, type LiveLoginIpAllow, type LoginIpAllowSpec } from './validate'

const BASE = '/ip_allow_list_login'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the list existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: { name: string; description: string; cidr: string[] }
}

export function loginIpAllowBody(spec: LoginIpAllowSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    cidr: spec.cidr,
  }
}

async function listLoginIpAllow(client: PcClient): Promise<{ ok: boolean; items: LiveLoginIpAllow[]; err?: string }> {
  const res = await client.get(BASE)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LiveLoginIpAllow[]>(res.body) ?? [] }
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

  const specs = extractLoginIpAllowSpecs(ctx.canvas).filter((s) => s.name && s.cidr.length > 0)

  const listed = await listLoginIpAllow(client)
  if (!listed.ok) return { success: false, message: `Failed to list login IP allow lists: ${listed.err}` }
  const liveByName = new Map<string, LiveLoginIpAllow>()
  const liveById = new Map<string, LiveLoginIpAllow>()
  for (const l of listed.items) {
    if (l.name) liveByName.set(l.name.toLowerCase(), l)
    if (l.id) liveById.set(l.id, l)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const createdNames: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.put(`${BASE}/${live.id}`, loginIpAllowBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        id: live.id,
        prior: { name: live.name ?? '', description: (live.description ?? '') as string, cidr: live.cidr ?? [] },
      })
    } else {
      // POST /ip_allow_list_login — the id is resolved after by re-listing (by name).
      const resp = await client.post(BASE, loginIpAllowBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      createdNames.push(spec.name)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: priorEntry?.id })
    }
  }

  // Resolve ids for freshly-created lists.
  if (createdNames.length) {
    const relisted = await listLoginIpAllow(client)
    if (relisted.ok) {
      const byName = new Map(relisted.items.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))
      for (const e of entries) {
        if (!e.existed && !e.id) e.id = byName.get(e.name.toLowerCase())?.id
      }
    }
  }

  // Reconcile: delete lists THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some login IP allow lists failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} login IP allow list(s)`, rollbackData: { entries } }
}
