import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractSenderSpecs, getSenderLists, readSenderList, scopeKey, scopeLabel, senderKey } from './validate'

/**
 * Health check for sender-list configuration:
 *   1. Essentials API reachability + credential/org validity (read each scope)
 *   2. Every declared entry is present in its target list (safe / blocked) within
 *      its declared scope (org / user / group)
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
  const byScope = new Map<string, { scope: string; scopeId: string }>()
  for (const spec of specs) byScope.set(scopeKey(spec.scope, spec.scopeId), { scope: spec.scope, scopeId: spec.scopeId })

  const start = Date.now()
  const listsByScope = new Map<string, { safe: Set<string>; blocked: Set<string> }>()
  try {
    for (const [key, { scope, scopeId }] of byScope) {
      const current = await getSenderLists(client, scope, scopeId)
      listsByScope.set(key, {
        safe: new Set(readSenderList(current, 'safe').map(senderKey)),
        blocked: new Set(readSenderList(current, 'blocked').map(senderKey)),
      })
    }
    checks.push({ name: 'pp_reachable', passed: true, message: `Proofpoint Essentials reachable — org "${orgDomain}"`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({
      name: 'pp_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  for (const spec of specs) {
    const lists = listsByScope.get(scopeKey(spec.scope, spec.scopeId))
    if (!lists) continue
    const set = spec.listType === 'blocked' ? lists.blocked : lists.safe
    const present = set.has(senderKey(spec.sender))
    const label = scopeLabel(spec.scope, spec.scopeId)
    checks.push({
      name: `sender:${spec.sender} (${spec.listType}) [${label}]`,
      passed: present,
      message: present
        ? `"${spec.sender}" is present in the ${spec.listType} list for ${label}`
        : `"${spec.sender}" is missing from the ${spec.listType} list for ${label}`,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
