import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { desiredEnabledRules, extractPimPolicySpecs, RULE_IDS, type LivePimRule } from './validate'
import { resolvePolicyId } from './deploy'

const POLICIES = '/policies/roleManagementPolicies'

type Diffs = DriftResult['diffs']

function sortedRules(rules: string[] | undefined): string {
  return [...(rules ?? [])].sort().join(',')
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractPimPolicySpecs(ctx.deployedConfig).filter((s) => s.roleDefinitionId)

  const diffs: Diffs = []
  for (const spec of specs) {
    const policyId = await resolvePolicyId(client, spec.roleDefinitionId)
    if (!policyId) {
      diffs.push({ field: spec.roleDefinitionId, expected: 'policy present', actual: 'absent', severity: 'critical' })
      continue
    }
    const rulesRes = await client.getAll<LivePimRule>(`${POLICIES}/${policyId}/rules`)
    if (!rulesRes.ok) continue
    const rulesById = new Map<string, LivePimRule>()
    for (const r of rulesRes.items) if (r.id) rulesById.set(r.id, r)

    const wantEnabled = sortedRules(desiredEnabledRules(spec))
    const liveEnabled = sortedRules(rulesById.get(RULE_IDS.enablement)?.enabledRules)
    if (wantEnabled !== liveEnabled) {
      diffs.push({ field: `${spec.roleDefinitionId}.enabledRules`, expected: wantEnabled || '(none)', actual: liveEnabled || '(none)', severity: 'warning' })
    }

    const liveExpiration = rulesById.get(RULE_IDS.expiration)
    if (spec.activationExpirationRequired !== (liveExpiration?.isExpirationRequired === true)) {
      diffs.push({
        field: `${spec.roleDefinitionId}.isExpirationRequired`,
        expected: String(spec.activationExpirationRequired),
        actual: String(liveExpiration?.isExpirationRequired === true),
        severity: 'warning',
      })
    }
    if (spec.activationMaximumDuration && spec.activationMaximumDuration !== (liveExpiration?.maximumDuration ?? '')) {
      diffs.push({
        field: `${spec.roleDefinitionId}.maximumDuration`,
        expected: spec.activationMaximumDuration,
        actual: liveExpiration?.maximumDuration ?? '',
        severity: 'warning',
      })
    }

    const liveApprovalRequired = rulesById.get(RULE_IDS.approval)?.setting?.isApprovalRequired === true
    if (spec.requireApprovalToActivate !== liveApprovalRequired) {
      diffs.push({
        field: `${spec.roleDefinitionId}.isApprovalRequired`,
        expected: String(spec.requireApprovalToActivate),
        actual: String(liveApprovalRequired),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
