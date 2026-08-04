import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractAuthSettingsSpec, getLoginSettings, getMfaSettings } from './validate'

/**
 * Health check for Authentication Settings:
 *   1. Essentials API reachability + credential/org validity (read both resources)
 *   2. Every declared MFA/Login field matches its live value
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'pp_credential', passed: false, message: built.error }] }
  }
  const { client, orgDomain } = built

  const spec = extractAuthSettingsSpec(ctx.canvas)
  const start = Date.now()

  try {
    const mfa = await getMfaSettings(client)
    const login = await getLoginSettings(client)
    checks.push({ name: 'pp_reachable', passed: true, message: `Proofpoint Essentials reachable — org "${orgDomain}"`, latencyMs: Date.now() - start })

    const mfaMatches = mfa.is_mfa_enabled === spec.isMfaEnabled && mfa.mfa_admins_only === spec.mfaAdminsOnly
    checks.push({
      name: 'mfa_settings',
      passed: mfaMatches,
      message: mfaMatches ? 'MFA settings match the declared configuration' : 'MFA settings drifted from the declared configuration',
    })

    const expectedIdp = spec.idpForForcedLogin || null
    const loginMatches =
      login.allow_local_login === spec.allowLocalLogin &&
      login.allow_azure_login === spec.allowAzureLogin &&
      login.force_azure_login === spec.forceAzureLogin &&
      (login.idp_for_forced_login ?? null) === expectedIdp
    checks.push({
      name: 'login_settings',
      passed: loginMatches,
      message: loginMatches ? 'Login/SSO settings match the declared configuration' : 'Login/SSO settings drifted from the declared configuration',
    })
  } catch (error) {
    checks.push({
      name: 'pp_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
