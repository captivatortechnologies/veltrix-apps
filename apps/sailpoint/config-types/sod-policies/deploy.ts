import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractSodPolicySpecs, parseJsonObject, type LiveSodPolicy, type SodPolicySpec } from './validate'

const BASE = '/v3/sod-policies'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; description: string; state: string; type: string; ownerType: string; ownerId: string }
}

/** Build the full SodPolicy body (owned entirely by the app; no readOnly fields sent). */
export function buildBody(spec: SodPolicySpec, criteria: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    state: spec.state,
    type: spec.type,
    compensatingControls: spec.compensatingControls,
    correctionAdvice: spec.correctionAdvice,
    tags: spec.tags,
    ownerRef: { type: spec.ownerType, id: spec.ownerId },
  }
  if (spec.type === 'CONFLICTING_ACCESS_BASED') {
    body.conflictingAccessCriteria = criteria
  } else {
    body.policyQuery = spec.policyQuery
  }
  return body
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

  const specs = extractSodPolicySpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveSodPolicy>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list SOD policies: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveSodPolicy>()
  const liveById = new Map<string, LiveSodPolicy>()
  for (const p of listed.items) {
    if (p.name) liveByName.set(p.name.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const parsed = parseJsonObject(spec.criteriaRaw)
    if (!parsed.ok) {
      failures.push(`${spec.name}: ${parsed.error}`)
      continue
    }
    const body = buildBody(spec, parsed.value)
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.put(`${BASE}/${live.id}`, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: { name: live.name ?? '', description: (live.description ?? '') as string, state: live.state ?? 'NOT_ENFORCED', type: live.type ?? 'GENERAL', ownerType: live.ownerRef?.type ?? 'IDENTITY', ownerId: live.ownerRef?.id ?? '' } })
    } else {
      const resp = await client.post(BASE, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveSodPolicy>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete SOD policies THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some SOD policies failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} SOD policy(ies)`, rollbackData: { entries } }
}
