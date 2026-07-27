import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  parseJson,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type CbClient,
} from '../../lib/carbonblack'
import { extractPolicySpecs, type PolicySpec, type LivePolicySummary } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  policyId?: string
  /** prior full policy so rollback can restore an updated policy. */
  prior?: Record<string, unknown>
}

/** The create/update body: the user's policy JSON with managed fields on top. */
export function policyBody(spec: PolicySpec, orgKey: string): Record<string, unknown> {
  // Drop any exported id in the pasted JSON — the id is path/response driven.
  const { id: _ignored, ...rest } = (spec.policyBody ?? {}) as Record<string, unknown>
  return {
    ...rest,
    org_key: orgKey,
    name: spec.name,
    description: spec.description,
    priority_level: spec.priorityLevel,
    is_system: false,
  }
}

async function listSummaries(client: CbClient, summaryPath: string): Promise<{ ok: boolean; items: LivePolicySummary[]; err?: string }> {
  const res = await client.get(summaryPath)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ policies?: LivePolicySummary[] } | LivePolicySummary[]>(res.body)
  const items = Array.isArray(parsed) ? parsed : parsed?.policies ?? []
  return { ok: true, items }
}

async function getPolicy(client: CbClient, policiesPath: string, id: string): Promise<Record<string, unknown> | undefined> {
  const res = await client.get(`${policiesPath}/${id}`)
  if (!res.ok) return undefined
  return parseJson<Record<string, unknown>>(res.body) ?? undefined
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
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildCbClient(cred, settings)
  const policiesPath = `/policyservice/v1/orgs/${cred.orgKey}/policies`
  const summaryPath = `${policiesPath}/summary`

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name && s.policyBody)

  const listed = await listSummaries(client, summaryPath)
  if (!listed.ok) return { success: false, message: `Failed to list policies: ${listed.err}` }
  const liveByName = new Map<string, LivePolicySummary>()
  const liveById = new Map<string, LivePolicySummary>()
  for (const p of listed.items) {
    if (p.name) liveByName.set(p.name.toLowerCase(), p)
    if (p.id !== undefined && p.id !== null) liveById.set(String(p.id), p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map<string, RollbackEntry>()
  for (const p of prior) if (p.itemId) priorByItem.set(p.itemId, p)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    // Prefer the prior-stored id (rename-safe) so a renamed policy updates in
    // place; otherwise fall back to matching the live set by name.
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live =
      (priorEntry?.policyId && liveById.get(priorEntry.policyId)) ||
      liveByName.get(spec.name.toLowerCase()) ||
      null

    if (live?.id !== undefined && live?.id !== null) {
      const id = String(live.id)
      const priorFull = await getPolicy(client, policiesPath, id)
      const updated = await client.put(`${policiesPath}/${id}`, { ...policyBody(spec, cred.orgKey), id: live.id })
      if (!updated.ok) {
        failures.push(`${spec.name}: ${cbErrorMessage(updated)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, policyId: id, prior: priorFull })
    } else {
      const resp = await client.post(policiesPath, policyBody(spec, cred.orgKey))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${cbErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<{ id?: number | string }>(resp.body)
      const id = created?.id !== undefined && created?.id !== null ? String(created.id) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, policyId: id })
    }
  }

  // Reconcile: delete policies THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.policyId).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.policyId && !keptIds.has(p.policyId) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${policiesPath}/${p.policyId}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${cbErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some policies failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} policy(ies)`, rollbackData: { entries } }
}
