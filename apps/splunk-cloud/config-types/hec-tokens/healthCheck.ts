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
import { extractHecTokenSpecs, parseHecEntity } from './validate'

const HEC_PATH = '/inputs/http-event-collectors'

/**
 * Health check for HEC token configuration:
 *   1. ACS reachability + token validity (GET /inputs/http-event-collectors?count=1)
 *   2. Every declared token exists and its enabled/disabled state matches
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
    const res = await acsRequest(acs, 'GET', `${HEC_PATH}?count=1`)
    if (res.status === 401) throw new Error('ACS token rejected (401) — token may be expired')
    if (res.status === 403) throw new Error('ACS token lacks required capabilities (403)')
    if (res.status !== 200) throw new Error(acsErrorMessage(res))
    return `ACS reachable for stack "${stack}"`
  })
  checks.push(reachable)

  // Check 2..n: each declared token exists with the expected enabled state
  if (reachable.passed) {
    const specs = extractHecTokenSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`hec-token:${spec.name}`, async () => {
          const res = await acsRequest(acs, 'GET', `${HEC_PATH}/${encodeURIComponent(spec.name)}`)
          if (res.status === 404) {
            throw new Error(`HEC token "${spec.name}" does not exist (or is still provisioning)`)
          }
          if (res.status !== 200) throw new Error(acsErrorMessage(res))

          const live = parseHecEntity(parseJson(res.body))?.spec
          const expectedDisabled = spec.disabled ?? false
          if (live && (live.disabled ?? false) !== expectedDisabled) {
            throw new Error(
              `HEC token "${spec.name}" is ${live.disabled ? 'disabled' : 'enabled'} but should be ${
                expectedDisabled ? 'disabled' : 'enabled'
              }`,
            )
          }
          return `HEC token "${spec.name}" is present and ${expectedDisabled ? 'disabled' : 'enabled'} as declared`
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
