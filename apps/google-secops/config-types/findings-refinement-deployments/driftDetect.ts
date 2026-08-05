import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, parseJson, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractFindingsRefinementDeploymentSpecs, type LiveFindingsRefinementDeployment } from './validate'
import { deploymentMatches, buildApplicationBody } from './deploy'
import { listRefinements, refinementIdOf } from '../findings-refinements/deploy'
import { listRules } from '../rules/deploy'

const enc = encodeURIComponent

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const listedRefinements = await listRefinements(client, parent)
  if (!listedRefinements.ok) return { hasDrift: false, diffs: [] }
  const byDisplayName = new Map(listedRefinements.refinements.map((r) => [r.displayName ?? '', r]))

  const listedRules = await listRules(client, parent)
  if (!listedRules.ok) return { hasDrift: false, diffs: [] }
  const ruleByDisplayName = new Map(listedRules.rules.map((r) => [r.displayName ?? '', r]))

  const specs = extractFindingsRefinementDeploymentSpecs(ctx.deployedConfig).filter((s) => s.refinementName)
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = byDisplayName.get(spec.refinementName)
    if (!live) {
      diffs.push({ field: spec.refinementName, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const getRes = await client.request('GET', `${parent}/findingsRefinements/${enc(refinementIdOf(live.name ?? ''))}/deployment`)
    if (!getRes.ok) continue
    const liveDep = parseJson<LiveFindingsRefinementDeployment>(getRes.body) ?? {}
    const { body: applicationBody, missing } = await buildApplicationBody(parent, spec, ruleByDisplayName)
    if (missing.length > 0) continue
    if (!deploymentMatches(liveDep, spec, applicationBody)) {
      diffs.push({
        field: `${spec.refinementName}.deployment`,
        expected: `enabled=${spec.enabled}, archived=${spec.archived}`,
        actual: `enabled=${liveDep.enabled ?? false}, archived=${liveDep.archived ?? false}`,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
