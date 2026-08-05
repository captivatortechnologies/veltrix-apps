import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { extractFindingsRefinementDeploymentSpecs, type FindingsRefinementDeploymentSpec, type LiveFindingsRefinementDeployment } from './validate'
import { listRefinements, refinementIdOf } from '../findings-refinements/deploy'
import { listRules, ruleIdOf } from '../rules/deploy'

// A findings refinement deployment is a singleton sub-resource of an EXISTING
// findings refinement — it is never created or deleted independently, only
// reconciled (the same content-vs-state split as rule-deployments). So every
// entry represents an UPDATE we can undo (existed is always true); there is no
// reconcile-delete pass.
export interface RollbackEntry {
  itemId?: string
  refinementName: string
  existed: boolean
  /** The server-assigned refinementId, kept so rollback can target it after a rename. */
  refinementId?: string
  prior?: { enabled: boolean; archived: boolean; application: { rules: string[]; curatedRuleSets: string[]; curatedRules: string[] } }
}

const enc = encodeURIComponent
const UPDATE_MASK = 'enabled,archived,detectionExclusionApplication'

/** Resolve rule DISPLAY NAMES to full `{parent}/rules/{ruleId}` resource paths. */
function resolveRulePaths(parent: string, ruleNames: string[], byDisplayName: Map<string, { name?: string }>): { paths: string[]; missing: string[] } {
  const paths: string[] = []
  const missing: string[] = []
  for (const name of ruleNames) {
    const rule = byDisplayName.get(name)
    if (!rule?.name) {
      missing.push(name)
      continue
    }
    paths.push(`${parent}/rules/${enc(ruleIdOf(rule.name))}`)
  }
  return { paths, missing }
}

export async function buildApplicationBody(
  parent: string,
  spec: FindingsRefinementDeploymentSpec,
  ruleByDisplayName: Map<string, { name?: string }>
): Promise<{ body: Record<string, unknown> | undefined; missing: string[] }> {
  if (!spec.application) return { body: undefined, missing: [] }
  const { ruleNames, curatedRuleSets, curatedRules } = spec.application
  if (ruleNames.length === 0 && curatedRuleSets.length === 0 && curatedRules.length === 0) {
    return { body: undefined, missing: [] }
  }
  const { paths, missing } = resolveRulePaths(parent, ruleNames, ruleByDisplayName)
  return { body: { rules: paths, curatedRuleSets, curatedRules }, missing }
}

export function buildDeploymentBody(spec: FindingsRefinementDeploymentSpec, applicationBody: Record<string, unknown> | undefined): Record<string, unknown> {
  return { enabled: spec.enabled, archived: spec.archived, detectionExclusionApplication: applicationBody ?? {} }
}

function normalizeApplication(live: LiveFindingsRefinementDeployment['detectionExclusionApplication']): { rules: string[]; curatedRuleSets: string[]; curatedRules: string[] } {
  return {
    rules: live?.rules ?? [],
    curatedRuleSets: live?.curatedRuleSets ?? [],
    curatedRules: live?.curatedRules ?? [],
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

/** Whether the live deployment already matches the desired state. */
export function deploymentMatches(live: LiveFindingsRefinementDeployment, spec: FindingsRefinementDeploymentSpec, desiredApplication: Record<string, unknown> | undefined): boolean {
  if ((live.enabled ?? false) !== spec.enabled) return false
  if ((live.archived ?? false) !== spec.archived) return false
  const liveApp = normalizeApplication(live.detectionExclusionApplication)
  const desired = (desiredApplication ?? {}) as { rules?: string[]; curatedRuleSets?: string[]; curatedRules?: string[] }
  return (
    sameSet(liveApp.rules, desired.rules ?? []) &&
    sameSet(liveApp.curatedRuleSets, desired.curatedRuleSets ?? []) &&
    sameSet(liveApp.curatedRules, desired.curatedRules ?? [])
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

  const specs = extractFindingsRefinementDeploymentSpecs(ctx.canvas).filter((s) => s.refinementName)
  const prior = await loadPriorEntries(ctx)

  // Resolve each declared refinement by its displayName (or the id stored last
  // deploy, rename-safe) — the same identity approach as the Findings Refinements type.
  const listedRefinements = await listRefinements(client, parent)
  if (!listedRefinements.ok) return { success: false, message: `Could not list Google SecOps findings refinements: ${listedRefinements.error}` }
  const byRefinementId = new Map(listedRefinements.refinements.map((r) => [refinementIdOf(r.name ?? ''), r]))
  const byRefinementDisplayName = new Map(listedRefinements.refinements.map((r) => [r.displayName ?? '', r]))
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  // Resolve rule display names (used inside detectionExclusionApplication.ruleNames)
  // against the same rule lister the Detection Rules / Rule Deployments types use.
  const listedRules = await listRules(client, parent)
  if (!listedRules.ok) return { success: false, message: `Could not list Google SecOps detection rules: ${listedRules.error}` }
  const ruleByDisplayName = new Map(listedRules.rules.map((r) => [r.displayName ?? '', r]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const liveRefinement = (priorEntry?.refinementId ? byRefinementId.get(priorEntry.refinementId) : undefined) ?? byRefinementDisplayName.get(spec.refinementName)
    if (!liveRefinement) {
      failures.push(`${spec.refinementName}: no such findings refinement — declare it with the Findings Refinements config type first`)
      continue
    }
    const refinementId = refinementIdOf(liveRefinement.name ?? '')

    if (!spec.application) {
      failures.push(`${spec.refinementName}: ${spec.applicationRaw ? 'invalid detection exclusion application JSON' : 'missing detection exclusion application'}`)
      continue
    }
    const { body: applicationBody, missing } = await buildApplicationBody(parent, spec, ruleByDisplayName)
    if (missing.length > 0) {
      failures.push(`${spec.refinementName}: no such detection rule(s) for scoping — ${missing.join(', ')}`)
      continue
    }

    const getRes = await client.request('GET', `${parent}/findingsRefinements/${enc(refinementId)}/deployment`)
    if (!getRes.ok) {
      failures.push(`${spec.refinementName}: ${secopsErrorMessage(getRes)}`)
      continue
    }
    const liveDep = parseJson<LiveFindingsRefinementDeployment>(getRes.body) ?? {}

    const priorState = { enabled: liveDep.enabled ?? false, archived: liveDep.archived ?? false, application: normalizeApplication(liveDep.detectionExclusionApplication) }
    if (!deploymentMatches(liveDep, spec, applicationBody)) {
      const resp = await client.request('PATCH', `${parent}/findingsRefinements/${enc(refinementId)}/deployment?updateMask=${UPDATE_MASK}`, buildDeploymentBody(spec, applicationBody))
      if (!resp.ok) {
        failures.push(`${spec.refinementName}: ${secopsErrorMessage(resp)}`)
        continue
      }
    }
    entries.push({ itemId: spec.itemId, refinementName: spec.refinementName, existed: true, refinementId, prior: priorState })
  }

  // No reconcile-delete: a findings refinement deployment cannot be deleted
  // independently of its parent refinement. When a spec is removed the
  // deployment is left at its last-set state; an explicit rollback restores it.

  if (failures.length) {
    return { success: false, message: `Some findings refinement deployments failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Reconciled ${entries.length} findings refinement deployment(s)`, rollbackData: { entries } }
}
