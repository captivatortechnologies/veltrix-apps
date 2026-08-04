import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient } from '../../lib/jumpcloudApi'
import { readPolicy, PASSWORD_MANAGER_NOT_ENABLED_MESSAGE } from './deploy'

/**
 * Health check for the Password Manager Policy singleton:
 *   1. JumpCloud API reachability + key validity.
 *   2. Password Manager is enabled for the org (the policy object exists).
 * Score is the fraction of passed checks.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  try {
    const live = await readPolicy(client)
    if (!live) {
      checks.push({ name: 'password_manager_enabled', passed: false, message: PASSWORD_MANAGER_NOT_ENABLED_MESSAGE, latencyMs: Date.now() - started })
    } else {
      checks.push({
        name: 'password_manager_enabled',
        passed: true,
        message: `Password Manager is enabled; vault export is ${live.disableExport ? 'disabled' : 'allowed'}.`,
        latencyMs: Date.now() - started,
      })
    }
  } catch (error) {
    checks.push({
      name: 'password_manager_enabled',
      passed: false,
      message: `JumpCloud unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
