import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, signAppIn, signOut } from '../../lib/beyondtrustApi'

/**
 * Health for managed-systems config = Password Safe accepts a PS-Auth sign-in
 * with the configured API key + run-as user. Read-only: POST /Auth/SignAppIn
 * then POST /Auth/Signout. A successful sign-in proves the endpoint resolves
 * AND the credential authenticates. Verify against a live BeyondTrust instance.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  const started = Date.now()
  try {
    const cookie = await signAppIn(base, credential, 8000)
    await signOut(base, cookie, 8000)
    checks.push({
      name: 'passwordsafe_signin',
      passed: true,
      message: 'Signed in to Password Safe (PS-Auth session established).',
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'passwordsafe_signin',
      passed: false,
      message: `Password Safe sign-in failed: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
