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
import { indexByLowerName, listTaggedFieldCategories } from '../../lib/lookups'
import { extractTaggedFieldSpecs, type LiveTaggedField, type TaggedFieldSpec } from './validate'

const PATH = '/ariel/taggedfields'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: number
  prior?: { categoryId: number; description: string }
}

export async function listTaggedFields(client: QRadarClient): Promise<LiveTaggedField[]> {
  const res = await client.request('GET', PATH, { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveTaggedField[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

/** Immutable-field mismatches between the live record and the spec (name, type,
 * private_enterprise_number, element_id, is_array — none of these can be changed
 * once the field exists). Empty array means the record can be updated in place. */
function immutableMismatches(live: LiveTaggedField, spec: TaggedFieldSpec): string[] {
  const problems: string[] = []
  if ((live.name ?? '') !== spec.name) problems.push(`name (live "${live.name}" vs declared "${spec.name}")`)
  if ((live.type ?? '') !== spec.type) problems.push(`type (live "${live.type}" vs declared "${spec.type}")`)
  if ((live.private_enterprise_number ?? 0) !== spec.privateEnterpriseNumber) problems.push('privateEnterpriseNumber')
  if ((live.element_id ?? 0) !== spec.elementId) problems.push('elementId')
  if ((live.is_array ?? false) !== spec.isArray) problems.push('isArray')
  return problems
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

  const specs = extractTaggedFieldSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId as string, p]))
  const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

  const [categories, live] = await Promise.all([listTaggedFieldCategories(client), listTaggedFields(client)])
  const categoryByName = indexByLowerName(categories)
  const byId = new Map(live.filter((f) => typeof f.id === 'number').map((f) => [f.id as number, f]))
  const byName = new Map(live.filter((f) => f.name).map((f) => [String(f.name).toLowerCase(), f]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const categoryId = categoryByName.get(spec.categoryName.toLowerCase())
    if (categoryId === undefined) {
      failures.push(`${spec.name}: unknown category "${spec.categoryName}"`)
      continue
    }

    const priorEntry = (spec.itemId && priorByItem.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const existing = (priorEntry?.id !== undefined && byId.get(priorEntry.id)) || byName.get(spec.name.toLowerCase())

    if (existing && typeof existing.id === 'number') {
      const mismatches = immutableMismatches(existing, spec)
      if (mismatches.length) {
        failures.push(`${spec.name}: cannot change immutable field(s) [${mismatches.join(', ')}] — delete and recreate this tagged field instead`)
        continue
      }
      const priorState = { categoryId: existing.category_id ?? 0, description: existing.description ?? '' }
      if (priorState.categoryId !== categoryId || priorState.description !== spec.description) {
        const resp = await client.request('POST', `${PATH}/${existing.id}`, { body: { category_id: categoryId, description: spec.description } })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: existing.id, prior: priorState })
    } else {
      const resp = await client.request('POST', PATH, {
        body: {
          name: spec.name,
          type: spec.type,
          private_enterprise_number: spec.privateEnterpriseNumber,
          element_id: spec.elementId,
          category_id: categoryId,
          is_array: spec.isArray,
          description: spec.description,
        },
      })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveTaggedField>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete tagged fields THIS app created previously but no longer declares.
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter(Boolean))
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && typeof p.id === 'number' && !(p.itemId && declaredItemIds.has(p.itemId)) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.request('DELETE', `${PATH}/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some tagged fields failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} tagged field(s)`, rollbackData: { entries } }
}
