import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, oneLoginErrorMessage } from '../../lib/oneLogin'
import { listPrivileges } from './deploy'
import { extractPrivilegeSpecs, type LivePrivilege } from './validate'

/**
 * Health check for privilege configuration:
 *   1. OneLogin account reachability + API credential validity AND that the
 *      account has a Delegated Administration subscription (GET
 *      /api/1/privileges - a 403/404 without one is surfaced as a clear
 *      message rather than a generic failure)
 *   2. Every declared privilege still exists, matched by name
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'onelogin_credential', passed: false, message: built.error }] }
  }
  const { client, domain } = built

  let privileges: LivePrivilege[] = []
  const reachable = await timedCheck('onelogin_reachable', async () => {
    const res = await client.request('GET', '/api/1/privileges')
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'OneLogin rejected the API credentials, or this account has no Delegated Administration subscription ' +
          '(required for the Privileges API)',
      )
    }
    if (!res.ok) throw new Error(oneLoginErrorMessage(res))
    privileges = await listPrivileges(client)
    return `OneLogin account ${domain} reachable (Delegated Administration enabled)`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractPrivilegeSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`privilege:${spec.name}`, async () => {
          const live = privileges.find((p) => p.name === spec.name)
          if (!live) throw new Error(`Privilege "${spec.name}" does not exist in the account`)
          return `Privilege "${spec.name}" is present`
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
