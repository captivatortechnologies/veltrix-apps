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
import type { LivePolicySummary } from '../policies/validate'
import { extractRuleConfigSpecs, RULE_CONFIG_CATEGORY, type RuleConfigSpec, type LiveRuleConfig } from './validate'

export interface PriorConfig {
  id: string
  WindowsAssignmentMode?: string
  exclusions?: Record<string, unknown>
}

export interface RollbackEntry {
  itemId?: string
  policyName: string
  policyId?: string
  /** Rule-config categories are platform-managed and always pre-exist — never created. */
  existed: boolean
  /** prior parameters/exclusions per config id, so rollback can restore them. */
  prior?: { configs: PriorConfig[] }
}

/** The PUT array body: set WindowsAssignmentMode on each core-prevention config. */
export function buildBody(spec: RuleConfigSpec, coreConfigs: LiveRuleConfig[]): Array<Record<string, unknown>> {
  return coreConfigs
    .filter((rc) => rc.id)
    .map((rc) => {
      const exclusions = spec.exclusions ?? rc.exclusions
      return {
        id: rc.id,
        parameters: { WindowsAssignmentMode: spec.assignmentMode },
        ...(exclusions ? { exclusions } : {}),
      }
    })
}

export function snapshotConfigs(coreConfigs: LiveRuleConfig[]): PriorConfig[] {
  return coreConfigs
    .filter((rc) => rc.id)
    .map((rc) => ({ id: rc.id!, WindowsAssignmentMode: rc.parameters?.WindowsAssignmentMode, exclusions: rc.exclusions }))
}

async function listPolicies(client: CbClient, summaryPath: string): Promise<{ ok: boolean; items: LivePolicySummary[]; err?: string }> {
  const res = await client.get(summaryPath)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ policies?: LivePolicySummary[] } | LivePolicySummary[]>(res.body)
  const items = Array.isArray(parsed) ? parsed : parsed?.policies ?? []
  return { ok: true, items }
}

async function listCoreConfigs(client: CbClient, ruleConfigsPath: string): Promise<{ ok: boolean; items: LiveRuleConfig[]; err?: string }> {
  const res = await client.get(ruleConfigsPath)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ results?: LiveRuleConfig[] } | LiveRuleConfig[]>(res.body)
  const all = Array.isArray(parsed) ? parsed : parsed?.results ?? []
  return { ok: true, items: all.filter((rc) => (rc.category ?? '').toLowerCase() === RULE_CONFIG_CATEGORY) }
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
  const policiesPath = client.policiesPath()

  const specs = extractRuleConfigSpecs(ctx.canvas).filter((s) => s.policyName)

  const policies = await listPolicies(client, `${policiesPath}/summary`)
  if (!policies.ok) return { success: false, message: `Failed to list policies: ${policies.err}` }
  const policyIdByName = new Map<string, string>()
  for (const p of policies.items) {
    if (p.name && p.id !== undefined && p.id !== null) policyIdByName.set(p.name.toLowerCase(), String(p.id))
  }

  const prior = await loadPriorEntries(ctx)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const policyId = policyIdByName.get(spec.policyName.toLowerCase())
    if (!policyId) {
      failures.push(`${spec.policyName}: policy not found`)
      continue
    }
    const rulePath = `${policiesPath}/${policyId}/rule_configs`
    const listed = await listCoreConfigs(client, rulePath)
    if (!listed.ok) {
      failures.push(`${spec.policyName}: ${listed.err}`)
      continue
    }
    if (listed.items.length === 0) {
      failures.push(`${spec.policyName}: no core_prevention rule configs on this policy`)
      continue
    }

    const priorConfigs = snapshotConfigs(listed.items)
    const put = await client.put(`${rulePath}/${RULE_CONFIG_CATEGORY}`, buildBody(spec, listed.items))
    if (!put.ok) {
      failures.push(`${spec.policyName}: ${cbErrorMessage(put)}`)
      continue
    }
    entries.push({ itemId: spec.itemId, policyName: spec.policyName, policyId, existed: true, prior: { configs: priorConfigs } })
  }

  // Reconcile: for policies we patched before but no longer declare, reset the
  // core_prevention category to its default (DELETE). We never delete the policy.
  const declaredItems = new Set(specs.map((s) => s.itemId).filter(Boolean) as string[])
  const declaredPolicies = new Set(entries.map((e) => e.policyId).filter(Boolean) as string[])
  for (const p of prior) {
    const stillDeclared = (p.itemId && declaredItems.has(p.itemId)) || (p.policyId && declaredPolicies.has(p.policyId))
    if (!stillDeclared && p.policyId) {
      const del = await client.delete(`${policiesPath}/${p.policyId}/rule_configs/${RULE_CONFIG_CATEGORY}`)
      if (!del.ok && del.status !== 404) failures.push(`reset ${p.policyName}: ${cbErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some policy rule configs failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} policy rule config(s)`, rollbackData: { entries } }
}
