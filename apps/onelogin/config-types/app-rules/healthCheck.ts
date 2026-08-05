import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, oneLoginErrorMessage } from '../../lib/oneLogin'
import { listAppRules } from './deploy'
import { extractAppRuleSpecs } from './validate'

/**
 * Health check for app-rule configuration:
 *   1. OneLogin account reachability + API credential validity (GET
 *      /api/2/apps)
 *   2. Every declared rule still exists under its target app, matched by
 *      (appId, name)
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'onelogin_credential', passed: false, message: built.error }] }
  }
  const { client, domain } = built

  const reachable = await timedCheck('onelogin_reachable', async () => {
    const res = await client.request('GET', '/api/2/apps', { query: { limit: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error('OneLogin rejected the API credentials (invalid client id/secret, or missing scope)')
    }
    if (!res.ok) throw new Error(oneLoginErrorMessage(res))
    return `OneLogin account ${domain} reachable`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractAppRuleSpecs(ctx.canvas).filter((s) => s.appId !== undefined && s.name)
    const cache = new Map<number, Awaited<ReturnType<typeof listAppRules>>>()
    for (const spec of specs) {
      const appId = spec.appId as number
      const label = `${spec.name} (app ${appId})`
      checks.push(
        await timedCheck(`rule:${label}`, async () => {
          if (!cache.has(appId)) cache.set(appId, await listAppRules(client, appId))
          const rules = cache.get(appId)!
          const live = rules.find((r) => r.name === spec.name)
          if (!live) throw new Error(`App rule "${label}" does not exist`)
          return `App rule "${label}" is present`
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
