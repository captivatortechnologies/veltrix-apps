import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, parseJson, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import type { LivePolicySummary } from '../policies/validate'
import { extractRuleConfigSpecs, RULE_CONFIG_CATEGORY, type LiveRuleConfig } from './validate'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)
  const policiesPath = client.policiesPath()

  const specs = extractRuleConfigSpecs(ctx.deployedConfig).filter((s) => s.policyName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const policyRes = await client.get(`${policiesPath}/summary`)
  if (!policyRes.ok) return { hasDrift: false, diffs: [] }
  const policyParsed = parseJson<{ policies?: LivePolicySummary[] } | LivePolicySummary[]>(policyRes.body)
  const policies = Array.isArray(policyParsed) ? policyParsed : policyParsed?.policies ?? []
  const policyIdByName = new Map<string, string>()
  for (const p of policies) if (p.name && p.id !== undefined && p.id !== null) policyIdByName.set(p.name.toLowerCase(), String(p.id))

  const diffs: Diffs = []
  for (const spec of specs) {
    const policyId = policyIdByName.get(spec.policyName.toLowerCase())
    if (!policyId) {
      diffs.push({ field: spec.policyName, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const res = await client.get(`${policiesPath}/${policyId}/rule_configs`)
    if (!res.ok) continue
    const parsed = parseJson<{ results?: LiveRuleConfig[] } | LiveRuleConfig[]>(res.body)
    const all = Array.isArray(parsed) ? parsed : parsed?.results ?? []
    const coreConfigs = all.filter((rc) => (rc.category ?? '').toLowerCase() === RULE_CONFIG_CATEGORY)
    if (coreConfigs.length === 0) {
      diffs.push({ field: `${spec.policyName}.core_prevention`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const off = coreConfigs.filter((rc) => (rc.parameters?.WindowsAssignmentMode ?? '') !== spec.assignmentMode)
    if (off.length) {
      diffs.push({ field: `${spec.policyName}.WindowsAssignmentMode`, expected: spec.assignmentMode, actual: off[0].parameters?.WindowsAssignmentMode ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
