import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, parseJson, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractRuleDeploymentSpecs, type LiveRuleDeployment } from './validate'
import { deploymentMatches } from './deploy'
import { listRules, ruleIdOf } from '../rules/deploy'

const enc = encodeURIComponent

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const listed = await listRules(client, parent)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const byDisplayName = new Map(listed.rules.map((r) => [r.displayName ?? '', r]))

  const specs = extractRuleDeploymentSpecs(ctx.deployedConfig).filter((s) => s.ruleName)
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = byDisplayName.get(spec.ruleName)
    if (!live) {
      diffs.push({ field: spec.ruleName, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const getRes = await client.request('GET', `${parent}/rules/${enc(ruleIdOf(live.name ?? ''))}/deployment`)
    if (!getRes.ok) continue
    const liveDep = parseJson<LiveRuleDeployment>(getRes.body) ?? {}
    if (!deploymentMatches(liveDep, spec)) {
      diffs.push({ field: `${spec.ruleName}.deployment`, expected: `enabled=${spec.enabled}, alerting=${spec.alerting}, ${spec.runFrequency}`, actual: `enabled=${liveDep.enabled ?? false}, alerting=${liveDep.alerting ?? false}, ${liveDep.runFrequency ?? 'RUN_FREQUENCY_UNSPECIFIED'}`, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
