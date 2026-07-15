import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, MISSING_ACCOUNT_MESSAGE } from '../../lib/cloudflare'
import { listServiceTokens } from './deploy'
import { extractServiceTokenSpecs, serviceTokenKey, type LiveServiceToken } from './validate'

/**
 * Health check for Access service token configuration:
 *   1. Cloudflare API reachability + account resolution (the token works, the
 *      account-scoped collection is listable)
 *   2. Every declared token still exists in the account — PRESENCE ONLY
 *
 * ⚠ SECURITY: only token presence (by name) is ever checked. The write-only
 * client_secret is never read, listed or compared.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'cloudflare_credential', passed: false, message: built.error }],
    }
  }
  const { client, domain } = built

  // Account-scoped: without an account id the check cannot succeed.
  if (!(await client.hasAccount())) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'cloudflare_account', passed: false, message: MISSING_ACCOUNT_MESSAGE }],
    }
  }

  const specs = extractServiceTokenSpecs(ctx.canvas).filter((s) => s.name)

  // Listing the account collection doubles as the reachability probe.
  const start = Date.now()
  let live: LiveServiceToken[] = []
  let reachError: string | null = null
  try {
    live = await listServiceTokens(client)
  } catch (error) {
    reachError = error instanceof Error ? error.message : 'Check failed'
  }
  checks.push({
    name: 'cloudflare_reachable',
    passed: reachError === null,
    message: reachError ?? `Cloudflare reachable; account resolved for zone "${domain}"`,
    latencyMs: Date.now() - start,
  })

  if (reachError === null && specs.length > 0) {
    const keys = new Set(live.filter((t) => t.name).map((t) => serviceTokenKey(t.name as string)))
    for (const spec of specs) {
      const present = keys.has(serviceTokenKey(spec.name))
      checks.push({
        name: `token:${spec.name}`,
        passed: present,
        message: present ? `Service token "${spec.name}" is present` : `Service token "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
