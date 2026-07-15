import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import { findMethodByName } from './deploy'
import { extractMfaMethodSpecs, type MfaMethodType } from './validate'

/**
 * Health check for login MFA method configuration:
 *   1. Vault reachable + unsealed (GET /sys/health — 200 active / 429 standby /
 *      472 DR / 473 perf-standby are reachable; 501 uninitialized and 503 sealed
 *      are failures)
 *   2. Token valid (GET /auth/token/lookup-self — 403 = token rejected)
 *   3. Every declared MFA method is still present (re-found by method_name)
 * Score is the percentage of passed checks (0–100).
 *
 * NOTE: this can only confirm a method EXISTS — the write-only secrets (duo /
 * okta / pingid) are never returned, so their correctness is not verifiable here.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'vault_credential', passed: false, message: built.error }],
    }
  }
  const { client, baseUrl } = built

  // Check 1: cluster reachable and unsealed
  const reachable = await timedCheck('vault_reachable', async () => {
    const res = await client.request('GET', '/sys/health')
    if (res.status === 501) throw new Error('Vault is not initialized')
    if (res.status === 503) throw new Error('Vault is sealed')
    // 200 active, 429 standby, 472 DR secondary, 473 performance standby.
    if (![200, 429, 472, 473].includes(res.status)) {
      throw new Error(`Vault health returned an unexpected status ${res.status}`)
    }
    return `Vault reachable and unsealed at ${baseUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    // Check 2: the token is accepted
    checks.push(
      await timedCheck('vault_token', async () => {
        const res = await client.request('GET', '/auth/token/lookup-self')
        if (res.status === 403) {
          throw new Error('Vault rejected the token (403) — check the credential and its policy')
        }
        if (!res.ok) throw new Error(vaultErrorMessage(res))
        return 'Vault token is valid'
      }),
    )

    // Check 3..n: each declared method is still present (re-found by method_name)
    const specs = extractMfaMethodSpecs(ctx.canvas).filter((s) => s.methodName && s.type)
    for (const spec of specs) {
      const type = spec.type as MfaMethodType
      checks.push(
        await timedCheck(`mfa-method:${spec.methodName}`, async () => {
          const live = await findMethodByName(client, type, spec.methodName)
          if (!live) throw new Error(`MFA method "${spec.methodName}" (${type}) is not present`)
          return `MFA method "${spec.methodName}" (${type}) is present`
        }),
      )
    }
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
