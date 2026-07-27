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
import { extractResourceListSpecs, type LiveResourceList, type ResourceListSpec } from './validate'

const BASE = '/v1/resource_list'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the resource list existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: { name: string; description: string; resourceListType: string; members: unknown[] }
}

export function resourceListBody(spec: ResourceListSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    resourceListType: spec.resourceListType,
    members: spec.members,
  }
}

async function listResourceLists(client: PcClient): Promise<{ ok: boolean; items: LiveResourceList[]; err?: string }> {
  const res = await client.get(BASE)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LiveResourceList[]>(res.body) ?? [] }
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

  const specs = extractResourceListSpecs(ctx.canvas).filter((s) => s.name && s.resourceListType && !s.membersError)

  const listed = await listResourceLists(client)
  if (!listed.ok) return { success: false, message: `Failed to list resource lists: ${listed.err}` }
  const liveByName = new Map<string, LiveResourceList>()
  const liveById = new Map<string, LiveResourceList>()
  for (const rl of listed.items) {
    if (rl.name) liveByName.set(rl.name.toLowerCase(), rl)
    if (rl.id) liveById.set(rl.id, rl)
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
      const resp = await client.put(`${BASE}/${live.id}`, resourceListBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        id: live.id,
        prior: { name: live.name ?? '', description: (live.description ?? '') as string, resourceListType: live.resourceListType ?? '', members: live.members ?? [] },
      })
    } else {
      const resp = await client.post(BASE, resourceListBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      // Prefer the id from the create response; fall back to a re-list by name.
      const created = parseJson<LiveResourceList>(resp.body)
      if (created?.id) {
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created.id })
      } else {
        createdNames.push(spec.name)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: priorEntry?.id })
      }
    }
  }

  // Resolve ids for freshly-created resource lists whose create returned no id.
  if (createdNames.length) {
    const relisted = await listResourceLists(client)
    if (relisted.ok) {
      const byName = new Map(relisted.items.filter((rl) => rl.name).map((rl) => [rl.name!.toLowerCase(), rl]))
      for (const e of entries) {
        if (!e.existed && !e.id) e.id = byName.get(e.name.toLowerCase())?.id
      }
    }
  }

  // Reconcile: delete resource lists THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some resource lists failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} resource list(s)`, rollbackData: { entries } }
}
