import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractSenderSpecs, getOrg, readSenderList, senderKey } from './validate'

/**
 * Health check for sender-list configuration:
 *   1. Essentials API reachability + credential/org validity (read the org)
 *   2. Every declared entry is present in its target list (safe / blocked)
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'pp_credential', passed: false, message: built.error }] }
  }
  const { client, orgDomain } = built

  const specs = extractSenderSpecs(ctx.canvas).filter((s) => s.sender)

  const start = Date.now()
  let safeKeys: Set<string> | null = null
  let blockedKeys: Set<string> | null = null
  try {
    const org = await getOrg(client)
    safeKeys = new Set(readSenderList(org, 'safe').map(senderKey))
    blockedKeys = new Set(readSenderList(org, 'blocked').map(senderKey))
    checks.push({ name: 'pp_reachable', passed: true, message: `Proofpoint Essentials reachable — org "${orgDomain}"`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({
      name: 'pp_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (safeKeys && blockedKeys) {
    for (const spec of specs) {
      const set = spec.listType === 'blocked' ? blockedKeys : safeKeys
      const present = set.has(senderKey(spec.sender))
      checks.push({
        name: `sender:${spec.sender} (${spec.listType})`,
        passed: present,
        message: present ? `"${spec.sender}" is present in the ${spec.listType} list` : `"${spec.sender}" is missing from the ${spec.listType} list`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
