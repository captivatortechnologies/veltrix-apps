import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, SENTINEL_API_VERSION, type SentinelClient } from '../../lib/sentinel'
import { extractAutomationSpecs } from './validate'

export interface LiveAutomationRule {
  name?: string
  properties?: {
    displayName?: string
    order?: number
    triggeringLogic?: { isEnabled?: boolean; triggersOn?: string; triggersWhen?: string }
    actions?: Array<{ actionType?: string; actionConfiguration?: { severity?: string; status?: string } }>
  }
}

/** List the workspace's automation rules; throws on a non-OK response. */
export async function listAutomationRules(client: SentinelClient): Promise<LiveAutomationRule[]> {
  const res = await client.getAll<LiveAutomationRule>(client.sentinelPath('/automationRules'), SENTINEL_API_VERSION)
  if (!res.ok) {
    throw new Error(res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`)
  }
  return res.items
}

/**
 * Health check for automation rules:
 *   1. ARM reachability + token/permission validity (an automationRules list)
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
  let live: LiveAutomationRule[] | null = null
  try {
    live = await listAutomationRules(client)
    checks.push({ name: 'arm_reachable', passed: true, message: `Azure Resource Manager reachable at ${armHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'arm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(live.filter((r) => r.name).map((r) => (r.name as string).toLowerCase()))
    for (const spec of extractAutomationSpecs(ctx.canvas).filter((s) => s.ruleName)) {
      const present = names.has(spec.ruleId.toLowerCase())
      checks.push({
        name: `rule:${spec.ruleName}`,
        passed: present,
        message: present ? `Automation rule "${spec.ruleName}" is present` : `Automation rule "${spec.ruleName}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
