import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { extractAllowlistSpecs, normalizeSubnet } from './validate'

/**
 * Health check for IP allow list configuration:
 *   1. Each feature's allow list is readable via ACS (also proves token validity)
 *   2. Every declared subnet is present on the live allow list
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      healthy: false,
      score: 0,
      checks: [
        {
          name: 'acs_token',
          passed: false,
          message: 'No ACS token — store the Splunk Cloud JWT in the credential "API token" field',
        },
      ],
    }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const specs = extractAllowlistSpecs(ctx.canvas).filter((s) => s.feature)

  for (const spec of specs) {
    const path = `/access/${encodeURIComponent(spec.feature)}/ipallowlists`

    let live: string[] | null = null

    checks.push(
      await timedCheck(`allowlist:${spec.feature}:readable`, async () => {
        const res = await acsRequest(acs, 'GET', path)
        if (res.status === 401) throw new Error('ACS token rejected (401) — token may be expired')
        if (res.status === 403) throw new Error('ACS token lacks required capabilities (403)')
        if (res.status !== 200) throw new Error(acsErrorMessage(res))
        live = (parseJson<{ subnets?: string[] }>(res.body)?.subnets ?? []).map(normalizeSubnet)
        return `Allow list for "${spec.feature}" is readable (${live.length} subnet(s))`
      }),
    )

    if (live !== null) {
      const liveSubnets: string[] = live
      checks.push(
        await timedCheck(`allowlist:${spec.feature}:subnets`, async () => {
          const missing = spec.subnets.filter((s) => !liveSubnets.includes(s))
          if (missing.length > 0) {
            throw new Error(
              `${missing.length} declared subnet(s) missing from "${spec.feature}": ${missing.join(', ')}`,
            )
          }
          return `All ${spec.subnets.length} declared subnet(s) present on "${spec.feature}"`
        }),
      )
    }
  }

  if (checks.length === 0) {
    checks.push({
      name: 'configuration',
      passed: false,
      message: 'No allow list features declared in the canvas',
    })
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
