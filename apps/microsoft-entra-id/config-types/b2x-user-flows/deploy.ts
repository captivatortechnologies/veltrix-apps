import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractB2xUserFlowSpecs, resultingId, type B2xUserFlowSpec, type LiveB2xUserFlow } from './validate'

const BASE = '/identity/b2xUserFlows'

export interface RollbackEntry {
  itemId?: string
  /** The resulting (prefixed) flow id. */
  name: string
  existed: boolean
  id?: string
}

/** POST body — the flow is create-only (no update); userFlowType is fixed. */
export function buildCreateBody(spec: B2xUserFlowSpec): Record<string, unknown> {
  return { id: spec.id, userFlowType: 'signUpOrSignIn', userFlowTypeVersion: spec.userFlowTypeVersion }
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

  const specs = extractB2xUserFlowSpecs(ctx.canvas).filter((s) => s.id)

  const listed = await client.getAll<LiveB2xUserFlow>(`${BASE}?$select=id,userFlowType,userFlowTypeVersion`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list b2x user flows: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveById = new Map<string, LiveB2xUserFlow>()
  for (const fl of listed.items) {
    if (fl.id) liveById.set(fl.id.toLowerCase(), fl)
  }

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const expectedId = resultingId(spec.id)
    const live = liveById.get(expectedId.toLowerCase()) ?? null

    if (live?.id) {
      // Flows have no update operation — an existing flow is left as-is.
      entries.push({ itemId: spec.itemId, name: live.id, existed: true, id: live.id })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.id}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveB2xUserFlow>(resp.body)
      entries.push({ itemId: spec.itemId, name: created?.id ?? expectedId, existed: false, id: created?.id ?? expectedId })
    }
  }

  // Reconcile: delete flows THIS app created previously but no longer declares.
  const declared = new Set(specs.map((s) => resultingId(s.id).toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id?.toLowerCase()).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id.toLowerCase()) && !declared.has(p.id.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some b2x user flows failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} b2x user flow(s)`,
    rollbackData: { entries },
  }
}
