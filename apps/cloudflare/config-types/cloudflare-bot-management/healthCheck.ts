import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage, cloudflareResult } from '../../lib/cloudflare'
import { extractBotManagementSpec, parseJsonObject, type LiveBotManagement } from './validate'

/** Normalize a live value to a comparable string, same treatment zone-settings gives its values. */
function normalize(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Health check for Bot Management configuration:
 *   1. Cloudflare API reachability + zone resolution (the token works, zone found)
 *   2. Every declared field reads back the configured value
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'cloudflare_credential', passed: false, message: built.error }],
    }
  }
  const { client, domain } = built

  const reachable = await timedCheck('cloudflare_reachable', async () => {
    const zone = await client.resolveZone()
    if ('error' in zone) throw new Error(zone.error)
    return `Cloudflare reachable; resolved zone for "${domain}"`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const spec = extractBotManagementSpec(ctx.canvas)
    if (spec) {
      const res = await client.zone('GET', '/bot_management')
      if (!res.ok) {
        checks.push({ name: 'bot_management', passed: false, message: `Failed to read settings: ${cloudflareErrorMessage(res)}` })
      } else {
        const live = cloudflareResult<LiveBotManagement>(res) ?? {}
        const declared: Record<string, unknown> = {
          ai_bots_protection: spec.aiBotsProtection,
          crawler_protection: spec.crawlerProtection,
          content_bots_protection: spec.contentBotsProtection,
          cf_robots_variant: spec.cfRobotsVariant,
          enable_js: spec.enableJs,
          using_latest_model: spec.usingLatestModel,
          ...(parseJsonObject(spec.advancedJson).value ?? {}),
        }
        for (const [key, expected] of Object.entries(declared)) {
          const actual = live[key]
          const matches = normalize(actual) === normalize(expected)
          checks.push({
            name: `bot_management:${key}`,
            passed: matches,
            message: matches
              ? `"${key}" is "${normalize(actual)}"`
              : `"${key}" is "${normalize(actual)}", expected "${normalize(expected)}"`,
          })
        }
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
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
