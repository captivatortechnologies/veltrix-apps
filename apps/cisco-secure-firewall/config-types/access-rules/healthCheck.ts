import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient } from '../../lib/fmc'
import { buildAccessControlPolicyIndex } from '../../lib/fmcRefs'
import { extractAccessRuleSpecs, accessRulesPath } from './validate'

/**
 * Health check: FMC reachability + credential validity (the policy list),
 * then for each policy referenced by a declared rule, that its accessrules
 * endpoint is reachable and every declared rule in it is present.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'fmc_credential', passed: false, message: built.error }] }
  }
  const { client, fmcUrl } = built

  const start = Date.now()
  const policyIndex = await buildAccessControlPolicyIndex(client)
  checks.push({ name: 'fmc_reachable', passed: true, message: `FMC reachable at ${fmcUrl}`, latencyMs: Date.now() - start })

  const specs = extractAccessRuleSpecs(ctx.canvas).filter((s) => s.policyName && s.name)
  const byPolicyName = new Map<string, typeof specs>()
  for (const spec of specs) {
    const group = byPolicyName.get(spec.policyName) ?? []
    group.push(spec)
    byPolicyName.set(spec.policyName, group)
  }

  for (const [policyName, policySpecs] of byPolicyName) {
    const policy = policyIndex.get(policyName.toLowerCase())
    if (!policy) {
      checks.push({ name: `policy:${policyName}`, passed: false, message: `Access Control Policy "${policyName}" was not found` })
      continue
    }

    const listed = await client.list(accessRulesPath(policy.id))
    if (!listed.ok) {
      checks.push({ name: `policy:${policyName}`, passed: false, message: `Failed to list rules for policy "${policyName}" (HTTP ${listed.status})` })
      continue
    }
    checks.push({ name: `policy:${policyName}`, passed: true, message: `Policy "${policyName}" rules are reachable` })

    const liveNames = new Set(listed.items.map((i) => (i.name ?? '').toLowerCase()).filter(Boolean))
    for (const spec of policySpecs) {
      const present = liveNames.has(spec.name.toLowerCase())
      checks.push({
        name: `access-rule:${policyName}/${spec.name}`,
        passed: present,
        message: present ? `"${spec.name}" is present in "${policyName}"` : `"${spec.name}" is missing from "${policyName}"`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
