import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import { getPlugin } from './deploy'
import { extractPluginSpecs, pluginKey } from './validate'

/**
 * Health check for plugin catalog configuration:
 *   1. Vault reachable + unsealed (GET /sys/health — unauth, but proves the
 *      cluster is up: 200 active / 429 standby / 472 DR / 473 perf-standby are
 *      reachable; 501 uninitialized and 503 sealed are failures)
 *   2. Token valid (GET /auth/token/lookup-self — 403 = token rejected)
 *   3. Every declared plugin is still registered as an EXTERNAL catalog entry
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

    // Check 3..n: each declared plugin is still registered as an external entry
    const specs = extractPluginSpecs(ctx.canvas).filter((s) => s.type && s.name)
    for (const spec of specs) {
      const key = pluginKey(spec.type, spec.name)
      checks.push(
        await timedCheck(`plugin:${key}`, async () => {
          const live = await getPlugin(client, spec.type, spec.name)
          if (!live) throw new Error(`Plugin "${key}" is not registered`)
          if (live.builtin === true) {
            throw new Error(`Plugin "${key}" resolves to a Vault BUILT-IN — the external registration is gone`)
          }
          return `Plugin "${key}" is registered`
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
