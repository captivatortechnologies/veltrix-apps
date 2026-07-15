import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage, cloudflareResult } from '../../lib/cloudflare'
import { extractZoneSettingSpecs, normalizeSettingValue, settingKey, type LiveSetting } from './validate'

/**
 * Health check for zone setting configuration:
 *   1. Cloudflare API reachability + zone resolution (the token works, zone found)
 *   2. Every declared setting still reads back the configured value
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
    const specs = extractZoneSettingSpecs(ctx.canvas).filter((s) => s.settingId && s.value)
    for (const spec of specs) {
      const id = settingKey(spec.settingId)
      const res = await client.zone('GET', `/settings/${id}`)
      if (!res.ok) {
        checks.push({
          name: `setting:${spec.settingId}`,
          passed: false,
          message: `Failed to read "${spec.settingId}": ${cloudflareErrorMessage(res)}`,
        })
        continue
      }
      const live = normalizeSettingValue(cloudflareResult<LiveSetting>(res)?.value)
      const matches = live === spec.value
      checks.push({
        name: `setting:${spec.settingId}`,
        passed: matches,
        message: matches
          ? `Setting "${spec.settingId}" is "${live}"`
          : `Setting "${spec.settingId}" is "${live}", expected "${spec.value}"`,
      })
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
