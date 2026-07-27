import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractWorkflowSpecs, parseJsonObject, type LiveWorkflow, type WorkflowSpec } from './validate'

const BASE = '/v3/workflows'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  /** Prior WorkflowBody snapshot, captured before an update so rollback can PUT it back. */
  prior?: Record<string, unknown>
}

/** Build a full WorkflowBody. On create, ISC forbids enabled=true, so callers
 *  pass enabled=false and enable afterwards via a PATCH. */
export function workflowBody(
  spec: WorkflowSpec,
  trigger: Record<string, unknown>,
  definition: Record<string, unknown>,
  enabled: boolean
): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    owner: { type: 'IDENTITY', id: spec.ownerId },
    trigger,
    definition,
    enabled,
  }
}

function snapshotLive(live: LiveWorkflow): Record<string, unknown> {
  return {
    name: live.name,
    description: live.description ?? '',
    owner: { type: 'IDENTITY', id: live.owner?.id ?? '' },
    trigger: live.trigger ?? {},
    definition: live.definition ?? {},
    enabled: live.enabled ?? false,
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
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const specs = extractWorkflowSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveWorkflow>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list workflows: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveWorkflow>()
  const liveById = new Map<string, LiveWorkflow>()
  for (const w of listed.items) {
    if (w.name) liveByName.set(w.name.toLowerCase(), w)
    if (w.id) liveById.set(w.id, w)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const trigger = parseJsonObject(spec.triggerRaw)
    const definition = parseJsonObject(spec.definitionRaw)
    if (!trigger.ok || !definition.ok) {
      failures.push(`${spec.name}: ${!trigger.ok ? trigger.error : (definition as { error: string }).error}`)
      continue
    }
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.put(`${BASE}/${live.id}`, workflowBody(spec, trigger.value, definition.value, spec.enabled))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: snapshotLive(live) })
    } else {
      // Workflows cannot be created enabled — POST disabled, then enable via PATCH.
      const resp = await client.post(BASE, workflowBody(spec, trigger.value, definition.value, false))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveWorkflow>(resp.body)
      if (created?.id && spec.enabled) {
        const enableResp = await client.patch(`${BASE}/${created.id}`, [{ op: 'replace', path: '/enabled', value: true }])
        if (!enableResp.ok) failures.push(`${spec.name}: created but failed to enable: ${iscErrorMessage(enableResp)}`)
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete workflows THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some workflows failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} workflow(s)`, rollbackData: { entries } }
}
