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
import { extractAnomalyTrustedListSpecs, type AnomalyTrustedListSpec, type LiveAnomalyTrustedList } from './validate'

const BASE = '/anomalies/trusted_list'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the list existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: {
    name: string
    description: string
    trustedListType: string
    accountId: string
    vpc: string
    applicablePolicies: string[]
    trustedListEntries: unknown[]
  }
}

export function anomalyTrustedListBody(spec: AnomalyTrustedListSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    trustedListType: spec.trustedListType,
    accountId: spec.accountId,
    vpc: spec.vpc,
    applicablePolicies: spec.applicablePolicies,
    trustedListEntries: spec.trustedListEntries,
  }
}

async function listLists(client: PcClient): Promise<{ ok: boolean; items: LiveAnomalyTrustedList[]; err?: string }> {
  const res = await client.get(BASE)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LiveAnomalyTrustedList[]>(res.body) ?? [] }
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

  const specs = extractAnomalyTrustedListSpecs(ctx.canvas).filter(
    (s) => s.name && s.trustedListType && !s.entriesError && s.trustedListEntries.length > 0 && s.applicablePolicies.length > 0
  )

  const listed = await listLists(client)
  if (!listed.ok) return { success: false, message: `Failed to list anomaly trusted lists: ${listed.err}` }
  const liveByName = new Map<string, LiveAnomalyTrustedList>()
  const liveById = new Map<string, LiveAnomalyTrustedList>()
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
      const resp = await client.put(`${BASE}/${live.id}`, anomalyTrustedListBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        id: live.id,
        prior: {
          name: live.name ?? '',
          description: (live.description ?? '') as string,
          trustedListType: live.trustedListType ?? spec.trustedListType,
          accountId: live.accountId ?? 'any',
          vpc: live.vpc ?? 'any',
          applicablePolicies: live.applicablePolicies ?? [],
          trustedListEntries: live.trustedListEntries ?? [],
        },
      })
    } else {
      const resp = await client.post(BASE, anomalyTrustedListBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAnomalyTrustedList>(resp.body)
      if (created?.id) {
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created.id })
      } else {
        createdNames.push(spec.name)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: priorEntry?.id })
      }
    }
  }

  // Resolve ids for freshly-created lists whose create returned no id.
  if (createdNames.length) {
    const relisted = await listLists(client)
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
    return { success: false, message: `Some anomaly trusted lists failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} anomaly trusted list(s)`, rollbackData: { entries } }
}
