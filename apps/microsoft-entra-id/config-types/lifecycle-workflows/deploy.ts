import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractWorkflowSpecs, parseArray, parseObject, type WorkflowSpec, type LiveWorkflow } from './validate'

const BASE = '/identityGovernance/lifecycleWorkflows/workflows'
const SELECT = '?$select=id,category,displayName,description,isEnabled,isSchedulingEnabled,executionConditions,tasks'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

/** Create body includes the immutable category; PATCH body omits it. */
export function buildCreateBody(spec: WorkflowSpec): Record<string, unknown> {
  return { category: spec.category, ...buildPatchBody(spec) }
}

export function buildPatchBody(spec: WorkflowSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    description: spec.description || '',
    isEnabled: spec.isEnabled,
    isSchedulingEnabled: spec.isSchedulingEnabled,
    executionConditions: parseObject(spec.executionConditions) ?? {},
    tasks: parseArray(spec.tasks) ?? [],
  }
}

function snapshotLive(live: LiveWorkflow): Record<string, unknown> {
  return {
    displayName: live.displayName,
    description: live.description ?? '',
    isEnabled: live.isEnabled ?? false,
    isSchedulingEnabled: live.isSchedulingEnabled ?? false,
    executionConditions: live.executionConditions ?? {},
    tasks: live.tasks ?? [],
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

  const specs = extractWorkflowSpecs(ctx.canvas).filter((s) => s.name && s.category)

  const listed = await client.getAll<LiveWorkflow>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list lifecycle workflows: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveWorkflow>()
  const liveById = new Map<string, LiveWorkflow>()
  for (const w of listed.items) {
    if (w.displayName) liveByName.set(w.displayName.toLowerCase(), w)
    if (w.id) liveById.set(w.id, w)
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
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildPatchBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveWorkflow>(resp.body)
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
    return { success: false, message: `Some lifecycle workflows failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} lifecycle workflow(s)`, rollbackData: { entries } }
}
