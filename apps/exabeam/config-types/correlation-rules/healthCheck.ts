import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildExabeamClient, exabeamErrorMessage } from '../../lib/exabeam'
import { listRules } from './deploy'
import { extractRuleSpecs } from './validate'
import type { LiveRule } from './validate'

/**
 * Health check for correlation-rule configuration:
 *   1. Exabeam reachability + API Key validity (GET /correlation-rules/v2/rules
 *      — a real list call, since the API exposes no lighter "ping"/whoami
 *      endpoint; 401/403 means the API Key was rejected)
 *   2. Every declared rule still exists (re-found by name)
 * A single list call backs both checks — respecting Exabeam's documented
 * per-IP rate limits (see README) rather than round-tripping twice.
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildExabeamClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'exabeam_credential', passed: false, message: built.error }],
    }
  }
  const { client, region } = built

  let rules: LiveRule[] = []
  const reachable = await timedCheck('exabeam_reachable', async () => {
    const listed = await listRules(client)
    if (!listed.ok) {
      throw new Error(exabeamErrorMessage({ status: listed.status, ok: false, body: listed.body }))
    }
    rules = listed.rules
    return `Exabeam correlation-rules API reachable (region ${region})`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const byName = new Set(rules.filter((r) => r.name).map((r) => r.name as string))
    const specs = extractRuleSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push({
        name: `rule:${spec.name}`,
        passed: byName.has(spec.name),
        message: byName.has(spec.name)
          ? `Rule "${spec.name}" is present`
          : `Rule "${spec.name}" does not exist in Exabeam`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)

  return {
    healthy: passedCount === checks.length,
    score,
    checks,
  }
}

async function timedCheck(
  name: string,
  fn: () => Promise<string>,
): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    }
  }
}
