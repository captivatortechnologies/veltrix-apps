import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, type SentinelClient } from '../../lib/sentinel'
import { extractProductSettingSpecs, settingKey, SENTINEL_SETTINGS_API_VERSION } from './validate'

/** A live Microsoft.SecurityInsights/settings singleton (only the fields we read). */
export interface LiveProductSetting {
  name?: string
  kind?: string
  properties?: {
    isEnabled?: boolean
    entityProviders?: string[]
    dataSources?: string[]
  }
}

/** List the workspace's product settings; throws on a non-OK response. */
export async function listSettings(client: SentinelClient): Promise<LiveProductSetting[]> {
  const res = await client.getAll<LiveProductSetting>(client.sentinelPath('/settings'), SENTINEL_SETTINGS_API_VERSION)
  if (!res.ok) {
    throw new Error(res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`)
  }
  return res.items
}

/**
 * Health check for product settings:
 *   1. ARM reachability + token/permission validity (a settings list)
 *   2. Every declared setting singleton is present in the workspace
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
  let live: LiveProductSetting[] | null = null
  try {
    live = await listSettings(client)
    checks.push({ name: 'arm_reachable', passed: true, message: `Azure Resource Manager reachable at ${armHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'arm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(live.filter((s) => s.name).map((s) => (s.name as string).toLowerCase()))
    for (const spec of extractProductSettingSpecs(ctx.canvas).filter((s) => s.setting)) {
      const present = names.has(settingKey(spec.setting))
      checks.push({
        name: `setting:${spec.setting}`,
        passed: present,
        message: present ? `Product setting "${spec.setting}" is present` : `Product setting "${spec.setting}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
