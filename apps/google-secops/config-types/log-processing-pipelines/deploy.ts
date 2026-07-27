import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { extractPipelineSpecs, type PipelineSpec, type LivePipeline } from './validate'

// The pipeline id is client-set, so identity is a clean name key (like reference
// lists / data access labels): GET by id, create-if-absent, PATCH otherwise,
// delete-owned on reconcile.
export interface RollbackEntry {
  itemId?: string
  id: string
  /** Whether the pipeline existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  prior?: { displayName: string; description: string; processors: unknown[] }
}

const enc = encodeURIComponent
const UPDATE_MASK = 'displayName,description,processors'

export function pipelineBody(spec: PipelineSpec): Record<string, unknown> {
  return { displayName: spec.displayName, description: spec.description, processors: spec.processors ?? [] }
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
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractPipelineSpecs(ctx.canvas).filter((s) => s.id && s.processors)
  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const getRes = await client.request('GET', `${parent}/logProcessingPipelines/${enc(spec.id)}`)

    if (getRes.ok) {
      const live = parseJson<LivePipeline>(getRes.body)
      const priorState = { displayName: live?.displayName ?? '', description: live?.description ?? '', processors: live?.processors ?? [] }
      const resp = await client.request('PATCH', `${parent}/logProcessingPipelines/${enc(spec.id)}?updateMask=${UPDATE_MASK}`, pipelineBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.id}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, id: spec.id, existed: true, prior: priorState })
    } else if (getRes.status === 404) {
      const resp = await client.request('POST', `${parent}/logProcessingPipelines?logProcessingPipelineId=${enc(spec.id)}`, pipelineBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.id}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, id: spec.id, existed: false, prior: { displayName: '', description: '', processors: [] } })
    } else {
      failures.push(`${spec.id}: ${secopsErrorMessage(getRes)}`)
    }
  }

  // Reconcile: delete pipelines THIS app created previously but no longer declares.
  const declaredIds = new Set(specs.map((s) => s.id.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && !declaredIds.has(p.id.toLowerCase())) {
      const del = await client.request('DELETE', `${parent}/logProcessingPipelines/${enc(p.id)}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${p.id}: ${secopsErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some log processing pipelines failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} log processing pipeline(s)`, rollbackData: { entries } }
}
