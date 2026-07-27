import { randomUUID } from 'crypto'
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
import { extractSavedSearchSpecs, type LiveSavedSearch, type SavedSearchSpec } from './validate'

const BASE = '/search/history'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the saved search existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: { name: string; description: string; query: string; searchType: string; cloudType: string; timeRange: Record<string, unknown> | null }
}

/** Build the Save body — a saved search is id-addressed and always carries saved:true. */
export function savedSearchBody(spec: SavedSearchSpec, id: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id,
    name: spec.name,
    description: spec.description,
    query: spec.query,
    searchType: spec.searchType,
    timeRange: spec.timeRange ?? {},
    saved: true,
  }
  if (spec.cloudType) body.cloudType = spec.cloudType
  return body
}

/** GET /search/history?filter=saved may return a bare array or an object wrapping one. */
function asSavedList(body: string): LiveSavedSearch[] {
  const parsed = parseJson<unknown>(body)
  if (Array.isArray(parsed)) return parsed as LiveSavedSearch[]
  if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as LiveSavedSearch[]
    }
  }
  return []
}

async function listSaved(client: PcClient): Promise<{ ok: boolean; items: LiveSavedSearch[]; err?: string }> {
  const res = await client.get(`${BASE}?filter=saved`)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: asSavedList(res.body).filter((s) => s.saved !== false) }
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

  const specs = extractSavedSearchSpecs(ctx.canvas).filter((s) => s.name && s.query && !s.timeRangeError && s.timeRange)

  const listed = await listSaved(client)
  if (!listed.ok) return { success: false, message: `Failed to list saved searches: ${listed.err}` }
  const liveByName = new Map<string, LiveSavedSearch>()
  const liveById = new Map<string, LiveSavedSearch>()
  for (const s of listed.items) {
    if (s.name) liveByName.set(s.name.toLowerCase(), s)
    if (s.id) liveById.set(s.id, s)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    // A saved search is id-addressed; we (re-)Save to the same id to create or update.
    const id = live?.id ?? priorEntry?.id ?? randomUUID()
    const resp = await client.post(`${BASE}/${id}`, savedSearchBody(spec, id))
    if (!resp.ok) {
      failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
      continue
    }
    if (live?.id) {
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        id: live.id,
        prior: {
          name: live.name ?? '',
          description: (live.description ?? '') as string,
          query: live.query ?? '',
          searchType: live.searchType ?? 'config',
          cloudType: live.cloudType ?? '',
          timeRange: live.timeRange ?? null,
        },
      })
    } else {
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id })
    }
  }

  // Reconcile: delete saved searches THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some saved searches failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} saved search(es)`, rollbackData: { entries } }
}
