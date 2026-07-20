import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { getCaptchaInstance, getOrgCaptcha } from './deploy'

/**
 * Health check for the CAPTCHA configuration:
 *   1. Okta API reachability + SSWS token validity (GET /org — proves the token
 *      is accepted and has admin read; 401/403 means the token was rejected)
 *   2. A CAPTCHA instance is present
 *   3. The org-wide CAPTCHA settings are readable
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'okta_credential', passed: false, message: built.error }],
    }
  }
  const { client, baseUrl } = built

  const reachable = await timedCheck('okta_reachable', async () => {
    const res = await client.request('GET', '/org')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Okta rejected the API token (SSWS) — check it is valid and belongs to an admin with read access')
    }
    if (!res.ok) throw new Error(oktaErrorMessage(res))
    return `Okta API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    checks.push(
      await timedCheck('captcha_instance_present', async () => {
        const instance = await getCaptchaInstance(client)
        if (!instance) throw new Error('No CAPTCHA instance is configured on the org')
        return `CAPTCHA instance "${instance.name ?? instance.id}" is present`
      }),
    )
    checks.push(
      await timedCheck('org_captcha_readable', async () => {
        const org = await getOrgCaptcha(client)
        const pages = Array.isArray(org?.enabledPages) ? org!.enabledPages!.join(', ') : 'none'
        return `Org-wide CAPTCHA settings readable (enabled pages: ${pages})`
      }),
    )
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
