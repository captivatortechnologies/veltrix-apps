import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, oneLoginErrorMessage } from '../../lib/oneLogin'
import { listBrands } from './deploy'
import { extractBrandSpecs, type LiveBrand } from './validate'

/**
 * Health check for brand configuration:
 *   1. OneLogin account reachability + API credential validity + that the
 *      Branding Early Preview feature is enabled (GET /api/2/branding/brands)
 *   2. Every declared brand still exists, matched by name
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'onelogin_credential', passed: false, message: built.error }] }
  }
  const { client, domain } = built

  let brands: LiveBrand[] = []
  const reachable = await timedCheck('onelogin_reachable', async () => {
    const res = await client.request('GET', '/api/2/branding/brands', { query: { limit: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'OneLogin rejected the API credentials, or the Branding API (Early Preview) is not enabled for this account',
      )
    }
    if (!res.ok) throw new Error(oneLoginErrorMessage(res))
    brands = await listBrands(client)
    return `OneLogin account ${domain} reachable (Branding Early Preview enabled)`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractBrandSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`brand:${spec.name}`, async () => {
          const live = brands.find((b) => b.name === spec.name)
          if (!live) throw new Error(`Brand "${spec.name}" does not exist in the account`)
          return `Brand "${spec.name}" is present`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(name: string, fn: () => Promise<string>): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
