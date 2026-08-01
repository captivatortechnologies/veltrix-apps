import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, sonarqubeRequest } from '../../lib/sonarqubeApi'

/**
 * Health for the permission-templates config = SonarQube answers its Web API and the token
 * authenticates. Read-only:
 *   - GET /api/system/status            → the server is UP (returns version)
 *   - GET /api/authentication/validate  → the token is accepted ({ valid: true })
 * Verify against your SonarQube version.
 */
interface SystemStatus {
  status?: string
  version?: string
}
interface AuthValidate {
  valid?: boolean
}

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const started = Date.now()
  try {
    const res = await sonarqubeRequest(`${base}/api/system/status`, { headers, timeoutMs: 8000 })
    let status: string | undefined
    let version: string | undefined
    try {
      const parsed = JSON.parse(res.body || '{}') as SystemStatus
      status = parsed.status
      version = parsed.version
    } catch {
      /* non-JSON body — treat as unknown status */
    }
    const passed = status === 'UP'
    checks.push({
      name: 'sonarqube_status',
      passed,
      message: passed ? `SonarQube is UP${version ? ` (v${version})` : ''}.` : `SonarQube status is "${status ?? `HTTP ${res.status}`}".`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({ name: 'sonarqube_status', passed: false, message: `SonarQube unreachable: ${error instanceof Error ? error.message : 'error'}`, latencyMs: Date.now() - started })
  }

  const authStarted = Date.now()
  try {
    const res = await sonarqubeRequest(`${base}/api/authentication/validate`, { headers, timeoutMs: 8000 })
    let valid = false
    try {
      valid = (JSON.parse(res.body || '{}') as AuthValidate).valid === true
    } catch {
      /* ignore */
    }
    checks.push({ name: 'token_valid', passed: valid, message: valid ? 'API token authenticates.' : 'API token was not accepted by SonarQube.', latencyMs: Date.now() - authStarted })
  } catch (error) {
    checks.push({ name: 'token_valid', passed: false, message: `Token validation failed: ${error instanceof Error ? error.message : 'error'}`, latencyMs: Date.now() - authStarted })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
