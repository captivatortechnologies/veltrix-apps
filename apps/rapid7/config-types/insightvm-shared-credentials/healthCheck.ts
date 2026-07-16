import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listCredentials } from './deploy'
import { credentialKey, extractCredentialSpecs, type LiveCredential } from './validate'

/**
 * Health check for shared-credential configuration:
 *   1. InsightVM console reachability + credential validity (a paged list)
 *   2. Every declared credential still exists (matched by name)
 * Score is the percentage of passed checks (0–100).
 *
 * ⚠ Presence is checked by name only — the secret is never read back or verified.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'insightvm_credential', passed: false, message: built.error }] }
  }
  const { client, consoleUrl } = built

  const start = Date.now()
  let live: LiveCredential[] | null = null
  try {
    live = await listCredentials(client)
    checks.push({
      name: 'insightvm_reachable',
      passed: true,
      message: `InsightVM console reachable at ${consoleUrl}`,
      latencyMs: Date.now() - start,
    })
  } catch (error) {
    checks.push({
      name: 'insightvm_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (live) {
    const keys = new Set(live.filter((c) => c.name).map((c) => credentialKey({ name: c.name as string })))
    for (const spec of extractCredentialSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = keys.has(credentialKey(spec))
      checks.push({
        name: `credential:${spec.name}`,
        passed: present,
        message: present ? `Credential "${spec.name}" is present` : `Credential "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
