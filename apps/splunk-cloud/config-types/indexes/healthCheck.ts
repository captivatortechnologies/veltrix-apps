import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { extractIndexSpecs } from './validate'

/**
 * Health check for Splunk Cloud index configuration:
 *   1. ACS reachability + token validity (GET /indexes?count=1)
 *   2. Every declared index exists on the stack
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

  // Check 1: ACS reachable and token accepted
  const reachable = await timedCheck('acs_reachable', async () => {
    const res = await acsRequest(acs, 'GET', '/indexes?count=1')
    if (res.status === 401) throw new Error('ACS token rejected (401) — token may be expired')
    if (res.status === 403) throw new Error('ACS token lacks required capabilities (403)')
    if (res.status !== 200) throw new Error(acsErrorMessage(res))
    return `ACS reachable for stack "${stack}"`
  })
  checks.push(reachable)

  // Check 2..n: each declared index exists
  if (reachable.passed) {
    const specs = extractIndexSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`index:${spec.name}`, async () => {
          const res = await acsRequest(acs, 'GET', `/indexes/${encodeURIComponent(spec.name)}`)
          if (res.status === 404) throw new Error(`Index "${spec.name}" does not exist on the stack`)
          if (res.status !== 200) throw new Error(acsErrorMessage(res))
          return `Index "${spec.name}" is present`
        }),
      )
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
