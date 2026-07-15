import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage } from '../../lib/vault'
import { getPolicy } from './deploy'
import { extractPolicySpecs } from './validate'

/**
 * Health check for ACL policy configuration:
 *   1. Vault reachable + unsealed + active (GET /sys/health — unauthenticated,
 *      but the status code encodes the node state)
 *   2. The token is valid (GET /auth/token/lookup-self — 403 = token rejected)
 *   3. Every declared policy still exists (GET /sys/policies/acl/{name})
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

  // Check 1: Vault reachable, unsealed and active. /sys/health encodes state in
  // the HTTP status: 200 active, 429 standby, 473 performance standby (all
  // reachable + unsealed); 501 uninitialized and 503 sealed are failures.
  const reachable = await timedCheck('vault_reachable', async () => {
    const res = await client.request('GET', '/sys/health')
    switch (res.status) {
      case 200:
        return `Vault is initialized, unsealed and active at ${baseUrl}`
      case 429:
        return `Vault is unsealed and reachable at ${baseUrl} (standby node)`
      case 473:
        return `Vault is unsealed and reachable at ${baseUrl} (performance standby)`
      case 501:
        throw new Error('Vault is not initialized')
      case 503:
        throw new Error('Vault is sealed')
      default:
        throw new Error(`Vault health check returned an unexpected status: ${vaultErrorMessage(res)}`)
    }
  })
  checks.push(reachable)

  // Check 2: the token is accepted (proves the credential is valid and unexpired)
  const tokenValid = await timedCheck('vault_token', async () => {
    const res = await client.request('GET', '/auth/token/lookup-self')
    if (res.status === 403) {
      throw new Error('Vault rejected the token (check the credential and its policies)')
    }
    if (!res.ok) throw new Error(vaultErrorMessage(res))
    const displayName = parseJson<{ data?: { display_name?: string } }>(res.body)?.data?.display_name
    return `Token accepted${displayName ? ` (${displayName})` : ''}`
  })
  checks.push(tokenValid)

  // Check 3..n: each declared policy still exists
  if (reachable.passed && tokenValid.passed) {
    const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name && s.policy)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`policy:${spec.name}`, async () => {
          const live = await getPolicy(client, spec.name)
          if (!live) throw new Error(`Policy "${spec.name}" does not exist in Vault`)
          return `Policy "${spec.name}" is present`
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
