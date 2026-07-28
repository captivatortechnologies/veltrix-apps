import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, SENTINEL_API_VERSION, type SentinelClient } from '../../lib/sentinel'
import { extractMsSecuritySpecs } from './validate'

export interface LiveMsSecurityRule {
  name?: string
  kind?: string
  properties?: Record<string, unknown>
}

/**
 * List the workspace's alert rules; throws on a non-OK response. Uses the GA
 * api-version — MicrosoftSecurityIncidentCreation is part of the stable AlertRule
 * contract, so the rules this config type manages are all returned.
 */
export async function listAlertRules(client: SentinelClient): Promise<LiveMsSecurityRule[]> {
  const res = await client.getAll<LiveMsSecurityRule>(client.sentinelPath('/alertRules'), SENTINEL_API_VERSION)
  if (!res.ok) {
    throw new Error(res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`)
  }
  return res.items
}

/**
 * Health check for Microsoft Security rules:
 *   1. ARM reachability + token/permission validity (an alertRules list)
 *   2. Every declared rule still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'sentinel_credential', passed: false, message: built.error }] }
  }
  const { client, armHost } = built

  const start = Date.now()
  let live: LiveMsSecurityRule[] | null = null
  try {
    live = await listAlertRules(client)
    checks.push({ name: 'arm_reachable', passed: true, message: `Azure Resource Manager reachable at ${armHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'arm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(live.filter((r) => r.name).map((r) => (r.name as string).toLowerCase()))
    for (const spec of extractMsSecuritySpecs(ctx.canvas).filter((s) => s.ruleName)) {
      const present = names.has(spec.ruleId.toLowerCase())
      checks.push({
        name: `rule:${spec.ruleName}`,
        passed: present,
        message: present ? `Microsoft Security rule "${spec.ruleName}" is present` : `Microsoft Security rule "${spec.ruleName}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
