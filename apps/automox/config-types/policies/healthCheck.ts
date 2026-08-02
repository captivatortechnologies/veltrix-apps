import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildAutomoxClient, automoxErrorMessage } from '../../lib/automoxApi'
import { listPolicies, findPolicyByName, type AutomoxPolicy } from '../lib/automoxPolicies'
import { extractPolicySpecs } from './_shared'

const POLICY_TYPE = 'patch' as const

/**
 * Health check for Policy configuration:
 *   1. Automox Console API reachability + API key validity (GET /policies —
 *      a 401/403 means the key was rejected, a 404 usually means a bad
 *      Organization ID).
 *   2. Every declared policy still exists in the org (matched by name).
 * Score is the fraction of passed checks.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildAutomoxClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  let livePolicies: AutomoxPolicy[] = []
  let reachable = false
  const started = Date.now()
  try {
    const res = await client.request('GET', '/policies', { query: { limit: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Automox rejected the API key (HTTP ${res.status}).`)
    }
    if (res.status === 404) {
      throw new Error(`Automox returned 404 for Organization ID ${client.orgId} — check the configured org id.`)
    }
    if (!res.ok) throw new Error(automoxErrorMessage(res))
    reachable = true
    livePolicies = await listPolicies(client)
    checks.push({
      name: 'automox_reachable',
      passed: true,
      message: `Automox Console API reachable and the API key is accepted (org ${client.orgId}).`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'automox_reachable',
      passed: false,
      message: `Automox unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    for (const spec of extractPolicySpecs(ctx.canvas).filter((s) => s.name)) {
      const live = findPolicyByName(livePolicies, spec.name, POLICY_TYPE)
      checks.push({
        name: `policy:${spec.name}`,
        passed: Boolean(live),
        message: live ? `Policy "${spec.name}" is present.` : `Policy "${spec.name}" was not found in the org.`,
      })
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
