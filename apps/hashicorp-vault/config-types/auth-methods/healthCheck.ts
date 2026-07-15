import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import { authKey, listAuthMethods } from './deploy'
import { extractAuthMethodSpecs, type LiveAuthMethod } from './validate'

/**
 * Health check for auth-method configuration:
 *   1. Vault reachable + unsealed + active — GET /sys/health (unauth). 200/429/473
 *      are reachable; 501 = uninitialized and 503 = sealed are failures.
 *   2. The token is valid — GET /auth/token/lookup-self (403 = token rejected).
 *   3. Every declared method is still enabled at its path with the expected type.
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

  // Check 1: reachability + seal/init status (unauthenticated, but proves the
  // cluster is up, unsealed and serving).
  const reachable = await timedCheck('vault_reachable', async () => {
    const res = await client.request('GET', '/sys/health')
    if (res.status === 501) throw new Error('Vault is not initialized')
    if (res.status === 503) throw new Error('Vault is sealed')
    // 200 active, 429 standby, 473 performance standby all mean "reachable".
    if (![200, 429, 473].includes(res.status)) throw new Error(vaultErrorMessage(res))
    return `Vault reachable at ${baseUrl} (health HTTP ${res.status})`
  })
  checks.push(reachable)

  // Check 2: the token is accepted (only worth trying if the cluster answered).
  let tokenOk = false
  if (reachable.passed) {
    const tokenCheck = await timedCheck('vault_token', async () => {
      const res = await client.request('GET', '/auth/token/lookup-self')
      if (res.status === 403) throw new Error('Vault rejected the token (403) — check the token and its policy')
      if (!res.ok) throw new Error(vaultErrorMessage(res))
      return 'Vault token accepted'
    })
    checks.push(tokenCheck)
    tokenOk = tokenCheck.passed
  }

  // Check 3..n: each declared method still enabled at its path with its type.
  if (tokenOk) {
    const specs = extractAuthMethodSpecs(ctx.canvas).filter((s) => s.path && s.type)
    if (specs.length > 0) {
      let live: Record<string, LiveAuthMethod> | null = null
      let listError: string | null = null
      try {
        live = await listAuthMethods(client)
      } catch (error) {
        listError = error instanceof Error ? error.message : 'unknown'
      }

      for (const spec of specs) {
        checks.push(
          await timedCheck(`authMethod:${spec.path}`, async () => {
            if (listError) throw new Error(`Could not list auth methods: ${listError}`)
            const entry = live?.[authKey(spec.path)]
            if (!entry) throw new Error(`Auth method "${spec.path}" is not enabled`)
            if ((entry.type ?? '') !== spec.type) {
              throw new Error(`Auth method "${spec.path}" has type "${entry.type}", expected "${spec.type}"`)
            }
            return `Auth method "${spec.path}" (${spec.type}) is enabled`
          }),
        )
      }
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
