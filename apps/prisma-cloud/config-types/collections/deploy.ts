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
import { extractCollectionSpecs, type CollectionSpec, type LiveCollection } from './validate'

const BASE = '/entitlement/api/v1/collection'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the collection existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: { name: string; description: string; assetGroups: Record<string, unknown> }
}

export function collectionBody(spec: CollectionSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    assetGroups: {
      accountGroupIds: spec.assetGroups.accountGroupIds,
      accountIds: spec.assetGroups.accountIds,
      repositoryIds: spec.assetGroups.repositoryIds,
    },
  }
}

function asCollectionList(body: string): LiveCollection[] {
  const parsed = parseJson<unknown>(body)
  if (Array.isArray(parsed)) return parsed as LiveCollection[]
  if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as LiveCollection[]
    }
  }
  return []
}

async function listCollections(client: PcClient): Promise<{ ok: boolean; items: LiveCollection[]; err?: string }> {
  const res = await client.get(BASE)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: asCollectionList(res.body) }
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

  const specs = extractCollectionSpecs(ctx.canvas).filter(
    (s) => s.name && (s.assetGroups.accountGroupIds.length || s.assetGroups.accountIds.length || s.assetGroups.repositoryIds.length)
  )

  const listed = await listCollections(client)
  if (!listed.ok) return { success: false, message: `Failed to list collections: ${listed.err}` }
  const liveByName = new Map<string, LiveCollection>()
  const liveById = new Map<string, LiveCollection>()
  for (const c of listed.items) {
    if (c.name) liveByName.set(c.name.toLowerCase(), c)
    if (c.id) liveById.set(c.id, c)
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
      const resp = await client.put(`${BASE}/${live.id}`, collectionBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        id: live.id,
        prior: { name: live.name ?? '', description: (live.description ?? '') as string, assetGroups: (live.assetGroups ?? {}) as Record<string, unknown> },
      })
    } else {
      const resp = await client.post(BASE, collectionBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveCollection>(resp.body)
      if (created?.id) {
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created.id })
      } else {
        createdNames.push(spec.name)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: priorEntry?.id })
      }
    }
  }

  // Resolve ids for freshly-created collections whose create returned no id.
  if (createdNames.length) {
    const relisted = await listCollections(client)
    if (relisted.ok) {
      const byName = new Map(relisted.items.filter((c) => c.name).map((c) => [c.name!.toLowerCase(), c]))
      for (const e of entries) {
        if (!e.existed && !e.id) e.id = byName.get(e.name.toLowerCase())?.id
      }
    }
  }

  // Reconcile: delete collections THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some collections failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} collection(s)`, rollbackData: { entries } }
}
