import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractExemptionSpecs, getExemptions, senderKey } from './validate'

/**
 * Health check for email-tagging exemptions:
 *   1. Essentials API reachability + credential/org validity (read the list)
 *   2. Every declared sender is present in the live exemption list
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'pp_credential', passed: false, message: built.error }] }
  }
  const { client, orgDomain } = built

  const specs = extractExemptionSpecs(ctx.canvas).filter((s) => s.sender)

  const start = Date.now()
  let currentKeys: Set<string> | null = null
  try {
    currentKeys = new Set((await getExemptions(client)).map(senderKey))
    checks.push({ name: 'pp_reachable', passed: true, message: `Proofpoint Essentials reachable — org "${orgDomain}"`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({
      name: 'pp_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (currentKeys) {
    for (const spec of specs) {
      const present = currentKeys.has(senderKey(spec.sender))
      checks.push({
        name: `exemption:${spec.sender}`,
        passed: present,
        message: present ? `"${spec.sender}" is exempt from email tagging` : `"${spec.sender}" is missing from the exemption list`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
