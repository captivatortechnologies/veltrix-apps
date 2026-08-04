import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { listAllNatRules } from './deploy'
import { extractNatRuleSpecs, natPackageKey, natRuleKey, type LiveNatRule } from './validate'

/**
 * Health check for Check Point NAT-rules configuration:
 *   1. Management API reachability + credential validity (login + one
 *      show-nat-rulebase per distinct declared package)
 *   2. Every declared rule (by name, within its package) still exists
 * Logs out at the end without publishing or discarding — read-only. Score is
 * the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'checkpoint_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const started = Date.now()
  const login = await client.login()
  if (login.error) {
    return { healthy: false, score: 0, checks: [{ name: 'checkpoint_login', passed: false, message: login.error }] }
  }

  const specs = extractNatRuleSpecs(ctx.canvas).filter((s) => s.name && s.package)
  const liveByPackage = new Map<string, LiveNatRule[]>()
  let reachable = true

  try {
    const packages = new Map(specs.map((s) => [natPackageKey(s.package), s.package]))
    for (const pkg of packages.values()) {
      liveByPackage.set(natPackageKey(pkg), await listAllNatRules(client, pkg))
    }
    checks.push({
      name: 'checkpoint_reachable',
      passed: true,
      message: `Reached the Check Point Management API at ${host}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    reachable = false
    checks.push({
      name: 'checkpoint_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'show-nat-rulebase failed',
      latencyMs: Date.now() - started,
    })
  } finally {
    await client.logout()
  }

  if (reachable) {
    for (const spec of specs) {
      const live = liveByPackage.get(natPackageKey(spec.package)) ?? []
      const present = live.some((r) => r.name && natRuleKey(r.name) === natRuleKey(spec.name))
      checks.push({
        name: `nat-rule:${spec.package}/${spec.name}`,
        passed: present,
        message: present
          ? `NAT rule "${spec.name}" is present in package "${spec.package}"`
          : `NAT rule "${spec.name}" is missing from package "${spec.package}"`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
