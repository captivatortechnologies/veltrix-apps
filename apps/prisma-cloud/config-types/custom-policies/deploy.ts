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
import { extractPolicySpecs, type LivePolicy, type PolicySpec } from './validate'

const LIST = '/v2/policy'
const SINGLE = '/policy'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the policy existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  /** the full prior policy object, restored verbatim on rollback. */
  prior?: Record<string, unknown>
}

export function policyBody(spec: PolicySpec): Record<string, unknown> {
  const parameters: Record<string, string> = { savedSearch: spec.criteria ? 'true' : 'false', withIac: String(spec.withIac) }
  const rule: Record<string, unknown> = {
    name: spec.ruleName || spec.name,
    type: spec.ruleType,
    parameters,
  }
  if (spec.criteria) rule.criteria = spec.criteria
  if (spec.resourceType) rule.resourceType = spec.resourceType

  const body: Record<string, unknown> = {
    name: spec.name,
    policyType: spec.policyType,
    cloudType: spec.cloudType,
    severity: spec.severity,
    description: spec.description,
    enabled: spec.enabled,
    recommendation: spec.recommendation,
    rule,
  }
  if (spec.labels.length) body.labels = spec.labels
  if (spec.policySubTypes.length) body.policySubTypes = spec.policySubTypes
  return body
}

async function listPolicies(client: PcClient): Promise<{ ok: boolean; items: LivePolicy[]; err?: string }> {
  const res = await client.get(LIST)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LivePolicy[]>(res.body) ?? [] }
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

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name && s.policyType && s.ruleType)

  const listed = await listPolicies(client)
  if (!listed.ok) return { success: false, message: `Failed to list policies: ${listed.err}` }
  // Only custom (non-system-default) policies are matchable — built-ins are protected.
  const liveByName = new Map<string, LivePolicy>()
  const liveById = new Map<string, LivePolicy>()
  for (const p of listed.items) {
    if (p.systemDefault) continue
    if (p.name) liveByName.set(p.name.toLowerCase(), p)
    if (p.policyId) liveById.set(p.policyId, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const createdNames: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.policyId) {
      const resp = await client.put(`${SINGLE}/${live.policyId}`, policyBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.policyId, prior: live as Record<string, unknown> })
    } else {
      // POST /policy returns no usable body — resolve the policyId after by re-listing.
      const resp = await client.post(SINGLE, policyBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      createdNames.push(spec.name)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: priorEntry?.id })
    }
  }

  // Resolve ids for freshly-created policies.
  if (createdNames.length) {
    const relisted = await listPolicies(client)
    if (relisted.ok) {
      const byName = new Map(relisted.items.filter((p) => !p.systemDefault && p.name).map((p) => [p.name!.toLowerCase(), p]))
      for (const e of entries) {
        if (!e.existed && !e.id) e.id = byName.get(e.name.toLowerCase())?.policyId
      }
    }
  }

  // Reconcile: delete custom policies THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${SINGLE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some policies failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} custom policy(ies)`, rollbackData: { entries } }
}
