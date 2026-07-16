import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
  splunkRestRequest,
} from '../../lib/splunkRest'
import { SAML_BASE_PATH } from './deploy'
import { extractSsoSpec, type LiveSamlProvider } from './validate'

/**
 * Health check for the SAML SSO provider configuration:
 *   1. the stack's REST API on port 8089 is reachable and the token is accepted
 *      (this is the check that tells the user whether Support has opened 8089
 *      and whether their IP is on the `search-api` allow list — the failure
 *      message names both)
 *   2. the declared SAML provider exists on the stack
 *   3. the live IdP entity ID matches the declared one
 * Score is the percentage of passed checks (0–100). Secret fields are never
 * inspected — the IdP certificate cannot be read back.
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
  const spec = extractSsoSpec(ctx.canvas)

  // Check 1: REST API reachable and token accepted (surfaces the two prerequisites).
  const reachable = await timedCheck('splunk_rest_reachable', async () => {
    await splunkRestRequest(`${baseUrl}${SAML_BASE_PATH}?count=1&output_mode=json`, {
      method: 'GET',
      headers: auth,
      timeoutMs,
    })
    return `Splunk Cloud REST API reachable for stack "${stack}" on port 8089`
  })
  checks.push(reachable)

  // Check 2..3: the declared provider exists and its entity ID matches.
  if (reachable.passed && spec.providerName) {
    let live: LiveSamlProvider | null = null
    const present = await timedCheck(`saml_provider:${spec.providerName}`, async () => {
      live = (await getEntityContent(
        baseUrl,
        auth,
        `${SAML_BASE_PATH}/${encodeURIComponent(spec.providerName)}`,
        timeoutMs,
      )) as LiveSamlProvider | null
      if (!live) throw new Error(`SAML provider "${spec.providerName}" does not exist on the stack`)
      return `SAML provider "${spec.providerName}" is present`
    })
    checks.push(present)

    if (present.passed && live && spec.entityId) {
      const liveProvider: LiveSamlProvider = live
      checks.push(
        await timedCheck('entity_id', async () => {
          if (liveProvider.entityId !== spec.entityId) {
            throw new Error(
              `IdP entity ID mismatch — declared "${spec.entityId}", live "${liveProvider.entityId ?? ''}"`,
            )
          }
          return `IdP entity ID matches ("${spec.entityId}")`
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
