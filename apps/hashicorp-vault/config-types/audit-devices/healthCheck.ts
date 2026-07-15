import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import { findLiveDevice, listAuditDevices } from './deploy'
import { extractAuditDeviceSpecs, type LiveAuditDevice } from './validate'

/**
 * Health check for audit device configuration:
 *   1. Vault reachable + unsealed + active  (GET /sys/health — unauthenticated;
 *      its STATUS CODE encodes cluster state: 200 active, 429 standby, 473 perf
 *      standby all count as reachable; 501 uninitialized and 503 sealed fail)
 *   2. The token is valid                    (GET /auth/token/lookup-self; 403 → rejected)
 *   3. Every declared audit device still exists (GET /sys/audit)
 * Score is the percentage of passed checks (0–100).
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

  // Check 1: Vault reachable, unsealed and serving (unauthenticated).
  const reachable = await timedCheck('vault_reachable', async () => {
    const res = await client.request('GET', '/sys/health')
    if (res.status === 501) throw new Error('Vault is not initialized')
    if (res.status === 503) throw new Error('Vault is sealed')
    // 200 = active, 429 = unsealed standby, 473 = performance standby — all mean
    // Vault is reachable and unsealed (sys/health signals state via the code).
    if (![200, 429, 473].includes(res.status)) throw new Error(vaultErrorMessage(res))
    return `Vault reachable at ${baseUrl} (HTTP ${res.status})`
  })
  checks.push(reachable)

  // Check 2: the token is accepted (proves the credential, not just reachability).
  let tokenValid: HealthCheckResult['checks'][0] | null = null
  if (reachable.passed) {
    tokenValid = await timedCheck('vault_token', async () => {
      const res = await client.request('GET', '/auth/token/lookup-self')
      if (res.status === 403) throw new Error('Vault rejected the token (check the credential and its policy)')
      if (!res.ok) throw new Error(vaultErrorMessage(res))
      return 'Vault token is valid'
    })
    checks.push(tokenValid)
  }

  // Check 3..n: each declared audit device still exists at its path.
  if (reachable.passed && tokenValid?.passed) {
    const specs = extractAuditDeviceSpecs(ctx.canvas).filter((s) => s.path && s.type)
    let liveMap: Record<string, LiveAuditDevice> | null = null
    let listError: string | null = null
    try {
      liveMap = await listAuditDevices(client)
    } catch (error) {
      listError = error instanceof Error ? error.message : 'Failed to list audit devices'
    }

    for (const spec of specs) {
      checks.push(
        await timedCheck(`audit:${spec.path}`, async () => {
          if (listError || !liveMap) throw new Error(listError ?? 'Failed to list audit devices')
          const live = findLiveDevice(liveMap, spec.path)
          if (!live) throw new Error(`Audit device "${spec.path}" is not enabled in Vault`)
          return `Audit device "${spec.path}" is present (type: ${live.type ?? 'unknown'})`
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
