import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { extractRuleDeploymentSpecs, type RuleDeploymentSpec, type LiveRuleDeployment } from './validate'
import { listRules, ruleIdOf } from '../rules/deploy'

// A rule's deployment is a singleton sub-resource of the rule — it is never
// created or deleted, only reconciled. So every entry represents an UPDATE we
// can undo (existed is always true); there is no reconcile-delete pass.
export interface RollbackEntry {
  itemId?: string
  ruleName: string
  existed: boolean
  /** The server-assigned ruleId, kept so rollback can target the deployment after a rename. */
  ruleName_live?: string
  prior?: { enabled: boolean; alerting: boolean; runFrequency: string }
}

const enc = encodeURIComponent
const UPDATE_MASK = 'enabled,alerting,runFrequency'

export function deploymentBody(spec: RuleDeploymentSpec): Record<string, unknown> {
  return { enabled: spec.enabled, alerting: spec.alerting, runFrequency: spec.runFrequency }
}

function normalizeFreq(freq: string | undefined): string {
  const f = (freq ?? '').toUpperCase()
  return f && f !== 'RUN_FREQUENCY_UNSPECIFIED' ? f : 'LIVE'
}

/** Whether the live deployment already matches the desired state. */
export function deploymentMatches(live: LiveRuleDeployment, spec: RuleDeploymentSpec): boolean {
  return (
    (live.enabled ?? false) === spec.enabled &&
    (live.alerting ?? false) === spec.alerting &&
    normalizeFreq(live.runFrequency) === spec.runFrequency
  )
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

  const specs = extractRuleDeploymentSpecs(ctx.canvas).filter((s) => s.ruleName)
  const prior = await loadPriorEntries(ctx)

  // Resolve each declared rule by its displayName (or the ruleId stored last
  // deploy, rename-safe) — the same identity approach as the Detection Rules type.
  const listed = await listRules(client, parent)
  if (!listed.ok) return { success: false, message: `Could not list Google SecOps rules: ${listed.error}` }
  const byRuleId = new Map(listed.rules.map((r) => [ruleIdOf(r.name ?? ''), r]))
  const byDisplayName = new Map(listed.rules.map((r) => [r.displayName ?? '', r]))
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live = (priorEntry?.ruleName_live ? byRuleId.get(priorEntry.ruleName_live) : undefined) ?? byDisplayName.get(spec.ruleName)
    if (!live) {
      failures.push(`${spec.ruleName}: no such detection rule — declare its text with the Detection Rules config type first`)
      continue
    }
    const ruleId = ruleIdOf(live.name ?? '')

    const getRes = await client.request('GET', `${parent}/rules/${enc(ruleId)}/deployment`)
    if (!getRes.ok) {
      failures.push(`${spec.ruleName}: ${secopsErrorMessage(getRes)}`)
      continue
    }
    const liveDep = parseJson<LiveRuleDeployment>(getRes.body) ?? {}
    if (liveDep.archived) {
      failures.push(`${spec.ruleName}: the rule deployment is archived — unarchive it before managing enabled / alerting / run frequency`)
      continue
    }

    const priorState = { enabled: liveDep.enabled ?? false, alerting: liveDep.alerting ?? false, runFrequency: normalizeFreq(liveDep.runFrequency) }
    if (!deploymentMatches(liveDep, spec)) {
      const resp = await client.request('PATCH', `${parent}/rules/${enc(ruleId)}/deployment?updateMask=${UPDATE_MASK}`, deploymentBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.ruleName}: ${secopsErrorMessage(resp)}`)
        continue
      }
    }
    entries.push({ itemId: spec.itemId, ruleName: spec.ruleName, existed: true, ruleName_live: ruleId, prior: priorState })
  }

  // No reconcile-delete: a rule deployment cannot be deleted independently of its
  // rule. When a spec is removed the deployment is left at its last-set state
  // (consistent with how the other types leave pre-existing objects) — an
  // explicit rollback restores the prior state.

  if (failures.length) {
    return { success: false, message: `Some rule deployments failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Reconciled ${entries.length} rule deployment(s)`, rollbackData: { entries } }
}
