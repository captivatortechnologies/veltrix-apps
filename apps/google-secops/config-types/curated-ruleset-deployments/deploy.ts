import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { extractCuratedDeploymentSpecs, type CuratedDeploymentSpec, type LiveCuratedDeployment } from './validate'

// A curated deployment is a pre-existing state object owned by Google — it is
// never created or deleted, only its enabled/alerting state is reconciled (like
// the rule-deployments type). Every entry is an UPDATE we can undo; there is no
// reconcile-delete and preserve-unowned is implicit (only declared ones are
// touched).
export interface RollbackEntry {
  itemId?: string
  category: string
  ruleSet: string
  precision: string
  existed: boolean
  prior?: { enabled: boolean; alerting: boolean }
}

const enc = encodeURIComponent
const UPDATE_MASK = 'enabled,alerting'

export function deploymentPath(parent: string, spec: { category: string; ruleSet: string; precision: string }): string {
  return `${parent}/curatedRuleSetCategories/${enc(spec.category)}/curatedRuleSets/${enc(spec.ruleSet)}/curatedRuleSetDeployments/${enc(spec.precision)}`
}

export function deploymentBody(spec: CuratedDeploymentSpec): Record<string, unknown> {
  return { enabled: spec.enabled, alerting: spec.alerting }
}

export function deploymentMatches(live: LiveCuratedDeployment, spec: CuratedDeploymentSpec): boolean {
  return (live.enabled ?? false) === spec.enabled && (live.alerting ?? false) === spec.alerting
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

  const specs = extractCuratedDeploymentSpecs(ctx.canvas).filter((s) => s.category && s.ruleSet)
  // Prior entries are loaded for parity with the other types; a curated deployment
  // is never deleted, so they are not used for a reconcile-delete pass.
  await loadPriorEntries(ctx)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const path = deploymentPath(parent, spec)
    const getRes = await client.request('GET', path)
    if (!getRes.ok) {
      failures.push(`${spec.category}/${spec.ruleSet}/${spec.precision}: ${secopsErrorMessage(getRes)}`)
      continue
    }
    const live = parseJson<LiveCuratedDeployment>(getRes.body) ?? {}
    const priorState = { enabled: live.enabled ?? false, alerting: live.alerting ?? false }
    if (!deploymentMatches(live, spec)) {
      const resp = await client.request('PATCH', `${path}?updateMask=${UPDATE_MASK}`, deploymentBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.category}/${spec.ruleSet}/${spec.precision}: ${secopsErrorMessage(resp)}`)
        continue
      }
    }
    entries.push({ itemId: spec.itemId, category: spec.category, ruleSet: spec.ruleSet, precision: spec.precision, existed: true, prior: priorState })
  }

  if (failures.length) {
    return { success: false, message: `Some curated rule set deployments failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Reconciled ${entries.length} curated rule set deployment(s)`, rollbackData: { entries } }
}
