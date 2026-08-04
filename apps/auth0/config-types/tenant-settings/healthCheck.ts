import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, auth0Fetch, bearer } from '../../lib/auth0Api'

const TENANT_SETTINGS_PATH = 'tenants/settings'

/**
 * Health for the tenant-settings config = Auth0 mints a Management API token
 * for the stored Machine-to-Machine credential and answers a minimal read
 * against the Tenants endpoint. Read-only: mint token (client-credentials) →
 * GET /tenants/settings?fields=friendly_name&include_fields=true.
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
    const res = await auth0Fetch(`${base}/${TENANT_SETTINGS_PATH}?fields=friendly_name&include_fields=true`, {
      headers: bearer(accessToken),
      timeoutMs: 8000,
    })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'tenant_settings_readable',
      passed,
      message: passed ? `Management API reachable (HTTP ${res.status}).` : `Management API returned HTTP ${res.status}.`,
      latencyMs: Date.now() - readStarted,
    })
  } catch (error) {
    checks.push({
      name: 'tenant_settings_readable',
      passed: false,
      message: `Management API unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - readStarted,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
