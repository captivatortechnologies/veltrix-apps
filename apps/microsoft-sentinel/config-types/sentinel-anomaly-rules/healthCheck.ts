import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, SENTINEL_API_VERSION, type SentinelClient } from '../../lib/sentinel'
import { extractAnomalySpecs } from './validate'

export interface LiveAnomalySetting {
  name?: string
  kind?: string
  properties?: Record<string, unknown>
}

/**
 * List the workspace's securityMLAnalyticsSettings; throws on a non-OK response.
 * Anomaly is the only kind of ML analytics setting, so no kind filter is needed.
 */
export async function listAnomalySettings(client: SentinelClient): Promise<LiveAnomalySetting[]> {
  const res = await client.getAll<LiveAnomalySetting>(client.sentinelPath('/securityMLAnalyticsSettings'), SENTINEL_API_VERSION)
  if (!res.ok) {
    throw new Error(res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`)
  }
  return res.items
}

/**
 * Health check for anomaly settings:
 *   1. ARM reachability + token/permission validity (a securityMLAnalyticsSettings list)
 *   2. Every declared setting still exists
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
  let live: LiveAnomalySetting[] | null = null
  try {
    live = await listAnomalySettings(client)
    checks.push({ name: 'arm_reachable', passed: true, message: `Azure Resource Manager reachable at ${armHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'arm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(live.filter((r) => r.name).map((r) => (r.name as string).toLowerCase()))
    for (const spec of extractAnomalySpecs(ctx.canvas).filter((s) => s.name)) {
      const present = names.has(spec.settingsResourceName.toLowerCase())
      checks.push({
        name: `anomaly:${spec.name}`,
        passed: present,
        message: present ? `Anomaly setting "${spec.name}" is present` : `Anomaly setting "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
