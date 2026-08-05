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
import { appsBasePath, appPath } from './deploy'
import { extractSplunkbaseAppSpecs } from './validate'

interface LiveSplunkbaseApp {
  version?: string
  status?: string
}

/**
 * Health check for Splunk Cloud Splunkbase apps:
 *   1. ACS reachability + token validity   GET .../apps/victoria?splunkbase=true&count=50
 *   2. every declared app is present and has status "installed"
 *
 * Only the stack token is needed here — reading installed apps does not
 * involve Splunkbase authentication (that is only needed to INSTALL/upgrade).
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
  const experience = settings.experience

  const reachable = await timedCheck('acs_reachable', async () => {
    const res = await acsRequest(acs, 'GET', `${appsBasePath(experience)}?splunkbase=true&count=50`)
    if (res.status === 401) throw new Error('ACS token rejected (401) — token may be expired')
    if (res.status === 403) throw new Error('ACS token lacks required capabilities (403)')
    if (res.status !== 200) throw new Error(acsErrorMessage(res))
    return `ACS Splunkbase apps API reachable for stack "${stack}" (${experience})`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractSplunkbaseAppSpecs(ctx.canvas).filter((s) => s.appName)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`app:${spec.appName}`, async () => {
          const res = await acsRequest(acs, 'GET', appPath(experience, spec.appName))
          if (res.status === 404) {
            throw new Error(`App "${spec.appName}" is not installed on the stack`)
          }
          if (res.status !== 200) throw new Error(acsErrorMessage(res))

          const live = parseJson<LiveSplunkbaseApp>(res.body) ?? {}
          if (live.status && live.status !== 'installed') {
            throw new Error(`App "${spec.appName}" is in state "${live.status}" — not fully installed`)
          }
          if (spec.version && live.version && live.version !== spec.version) {
            throw new Error(
              `App "${spec.appName}" is at version ${live.version}, the canvas declares ${spec.version}`,
            )
          }
          return `App "${spec.appName}" is installed${live.version ? ` at version ${live.version}` : ''}`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return {
    healthy: passedCount === checks.length,
    score: Math.round((passedCount / checks.length) * 100),
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
