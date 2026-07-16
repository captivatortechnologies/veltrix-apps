import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
} from '../../lib/splunkRest'
import { TOKEN_AUTH_SETTINGS_PATH } from './deploy'
import { extractTokenSettingsSpec, isTokenAuthEnabled, readLiveExpiration } from './validate'

/**
 * Health check for token-authentication settings:
 *   1. the stack's REST API on port 8089 is reachable and the token is accepted
 *      (this is the check that tells the user whether Support has opened 8089
 *      and whether their IP is on the `search-api` allow list — the failure
 *      message names both)
 *   2. live token-auth enablement matches the declared tokenAuthEnabled
 *   3. live default expiration matches the declared defaultExpiration (when set)
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const token = resolveRestToken(ctx.credential)
  if (!token) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'splunk_rest_token', passed: false, message: REST_TOKEN_MISSING }],
    }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const stack = resolveStackHost(ctx.component.hostname)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)
  const spec = extractTokenSettingsSpec(ctx.canvas)

  // Check 1: REST API reachable, token accepted, settings entity readable.
  let live: Record<string, unknown> | null = null
  const reachable = await timedCheck('token_settings_readable', async () => {
    live = await getEntityContent(baseUrl, auth, TOKEN_AUTH_SETTINGS_PATH, timeoutMs)
    if (!live) throw new Error('Token-authentication settings entity not found on the stack')
    return `Token-authentication settings readable on stack "${stack}" (port 8089)`
  })
  checks.push(reachable)

  // Check 2..3: declared settings match live — only when the settings are readable.
  if (reachable.passed && live && spec) {
    const liveContent: Record<string, unknown> = live

    if (spec.tokenAuthEnabled !== undefined) {
      checks.push(
        await timedCheck('token_auth_enabled', async () => {
          const liveEnabled = isTokenAuthEnabled(liveContent)
          if (liveEnabled !== spec.tokenAuthEnabled) {
            throw new Error(
              `Token authentication is ${liveEnabled ? 'enabled' : 'disabled'} on the stack but declared ${spec.tokenAuthEnabled ? 'enabled' : 'disabled'}`,
            )
          }
          return `Token authentication is ${liveEnabled ? 'enabled' : 'disabled'} as declared`
        }),
      )
    }

    if (spec.defaultExpiration !== undefined) {
      checks.push(
        await timedCheck('default_expiration', async () => {
          const liveExpiration = readLiveExpiration(liveContent)
          if (liveExpiration !== spec.defaultExpiration) {
            throw new Error(
              `Default token expiration is "${liveExpiration ?? 'not set'}" but declared "${spec.defaultExpiration}"`,
            )
          }
          return `Default token expiration is "${spec.defaultExpiration}" as declared`
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
