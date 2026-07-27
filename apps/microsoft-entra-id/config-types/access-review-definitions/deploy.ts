import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  extractAccessReviewSpecs,
  parseArray,
  parseObject,
  type AccessReviewSpec,
  type LiveAccessReview,
} from './validate'

const BASE = '/identityGovernance/accessReviews/definitions'
const SELECT = '?$select=id,displayName,descriptionForAdmins,scope,reviewers,settings'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

export function buildBody(spec: AccessReviewSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    descriptionForAdmins: spec.descriptionForAdmins || '',
    scope: parseObject(spec.scope) ?? {},
    reviewers: parseArray(spec.reviewers) ?? [],
    settings: parseObject(spec.settings) ?? {},
  }
}

function snapshotLive(live: LiveAccessReview): Record<string, unknown> {
  return {
    displayName: live.displayName,
    descriptionForAdmins: live.descriptionForAdmins ?? '',
    scope: live.scope ?? {},
    reviewers: live.reviewers ?? [],
    settings: live.settings ?? {},
  }
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
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractAccessReviewSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveAccessReview>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list access reviews: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveAccessReview>()
  const liveById = new Map<string, LiveAccessReview>()
  for (const d of listed.items) {
    if (d.displayName) liveByName.set(d.displayName.toLowerCase(), d)
    if (d.id) liveById.set(d.id, d)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAccessReview>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some access reviews failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} access review definition(s)`, rollbackData: { entries } }
}
