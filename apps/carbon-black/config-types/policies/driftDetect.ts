import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, parseJson, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import { extractPolicySpecs, type LivePolicySummary } from './validate'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)
  const summaryPath = `/policyservice/v1/orgs/${cred.orgKey}/policies/summary`

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name && s.policyBody)
  const listRes = await client.get(summaryPath)
  if (!listRes.ok) return { hasDrift: false, diffs: [] }
  const parsed = parseJson<{ policies?: LivePolicySummary[] } | LivePolicySummary[]>(listRes.body)
  const policies = Array.isArray(parsed) ? parsed : parsed?.policies ?? []
  const liveByName = new Map(policies.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))

  // The policy JSON body is server-normalized, so drift is scoped to the
  // fields this config type manages directly: priority level and description.
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.priority_level ?? '') !== spec.priorityLevel) {
      diffs.push({ field: `${spec.name}.priority_level`, expected: spec.priorityLevel, actual: live.priority_level ?? '', severity: 'warning' })
    }
    if ((live.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
