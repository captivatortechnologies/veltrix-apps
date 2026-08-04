import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { auth0Fetch, bearer, resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials } from '../../lib/auth0Api'
import { EMAIL_PROVIDER_PATH } from './_shared'

/**
 * Health for the email-provider config = mint a Management API token, then
 * GET /emails/provider. A 404 (no provider configured yet) is a PASSING
 * check — it proves Management API + scope access; "not configured yet" is
 * not a connectivity failure. Any other non-2xx fails the check.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    checks.push({ name: 'credential', passed: false, message: 'No Client ID / Client Secret attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)
  const started = Date.now()

  let accessToken: string
  try {
    accessToken = (await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })).accessToken
    checks.push({ name: 'management_token', passed: true, message: 'Minted a Management API access token.', latencyMs: Date.now() - started })
  } catch (error) {
    checks.push({
      name: 'management_token',
      passed: false,
      message: `Could not mint a Management API token: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
    return { healthy: false, score: 0, checks }
  }

  const readStarted = Date.now()
  try {
    const res = await auth0Fetch(`${base}/${EMAIL_PROVIDER_PATH}`, { headers: bearer(accessToken), timeoutMs: 8000 })
    const passed = res.status === 404 || res.ok
    checks.push({
      name: 'email_provider_readable',
      passed,
      message:
        res.status === 404
          ? 'No email provider configured yet (HTTP 404) — Management API access confirmed.'
          : passed
            ? `Management API reachable (HTTP ${res.status}).`
            : `Management API returned HTTP ${res.status}.`,
      latencyMs: Date.now() - readStarted,
    })
  } catch (error) {
    checks.push({
      name: 'email_provider_readable',
      passed: false,
      message: `Management API unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - readStarted,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
