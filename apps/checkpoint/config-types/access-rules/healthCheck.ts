import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { listAllRules } from './deploy'
import { extractAccessRuleSpecs, ruleGroupKey, ruleKey, type LiveAccessRule } from './validate'

/**
 * Health check for Check Point access-rules configuration:
 *   1. Management API reachability + credential validity (login + one
 *      show-access-rulebase per distinct declared layer/package)
 *   2. Every declared rule (by name, within its layer/package) still exists
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

  const specs = extractAccessRuleSpecs(ctx.canvas).filter((s) => s.name && s.layer)
  const liveByGroup = new Map<string, LiveAccessRule[]>()
  let reachable = true

  try {
    const groups = new Map(specs.map((s) => [ruleGroupKey(s.layer, s.package), s]))
    for (const spec of groups.values()) {
      liveByGroup.set(ruleGroupKey(spec.layer, spec.package), await listAllRules(client, spec.layer, spec.package))
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
      message: error instanceof Error ? error.message : 'show-access-rulebase failed',
      latencyMs: Date.now() - started,
    })
  } finally {
    await client.logout()
  }

  if (reachable) {
    for (const spec of specs) {
      const live = liveByGroup.get(ruleGroupKey(spec.layer, spec.package)) ?? []
      const present = live.some((r) => r.name && ruleKey(r.name) === ruleKey(spec.name))
      checks.push({
        name: `rule:${spec.layer}/${spec.name}`,
        passed: present,
        message: present
          ? `Rule "${spec.name}" is present in layer "${spec.layer}"`
          : `Rule "${spec.name}" is missing from layer "${spec.layer}"`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
