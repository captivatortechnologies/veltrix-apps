import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  parseJson,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type QRadarClient,
} from '../../lib/qradar'
import { listTaggedFieldCategories } from '../../lib/lookups'
import { extractTaggedFieldCategorySpecs, type LiveTaggedFieldCategory, type TaggedFieldCategorySpec } from './validate'

const PATH = '/ariel/taggedfieldcategories'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: number
  prior?: { name: string }
}

export async function listCategories(client: QRadarClient): Promise<LiveTaggedFieldCategory[]> {
  return listTaggedFieldCategories(client)
}

function matchLive(
  spec: TaggedFieldCategorySpec,
  priorId: number | undefined,
  byId: Map<number, LiveTaggedFieldCategory>,
  byName: Map<string, LiveTaggedFieldCategory>
): LiveTaggedFieldCategory | undefined {
  if (priorId !== undefined && byId.has(priorId)) return byId.get(priorId)
  return byName.get(spec.name.toLowerCase())
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
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const specs = extractTaggedFieldCategorySpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId as string, p]))
  const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

  const live = await listCategories(client)
  const byId = new Map(live.filter((c) => typeof c.id === 'number').map((c) => [c.id as number, c]))
  const byName = new Map(live.filter((c) => c.name).map((c) => [String(c.name).toLowerCase(), c]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItem.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const existing = matchLive(spec, priorEntry?.id, byId, byName)

    if (existing && typeof existing.id === 'number') {
      const priorState = { name: existing.name ?? '' }
      if (priorState.name !== spec.name) {
        const resp = await client.request('POST', `${PATH}/${existing.id}`, { body: { name: spec.name } })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: existing.id, prior: priorState })
    } else {
      const resp = await client.request('POST', PATH, { body: { name: spec.name } })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveTaggedFieldCategory>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete categories THIS app created previously but no longer declares.
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter(Boolean))
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && typeof p.id === 'number' && !(p.itemId && declaredItemIds.has(p.itemId)) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.request('DELETE', `${PATH}/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some tagged field categories failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} tagged field categor${entries.length === 1 ? 'y' : 'ies'}`, rollbackData: { entries } }
}
