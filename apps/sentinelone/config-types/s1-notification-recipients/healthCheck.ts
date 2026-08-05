import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, MISSING_SCOPE_MESSAGE } from '../../lib/s1'
import { listRecipients } from './deploy'
import { extractRecipientSpecs, recipientKey, RECIPIENTS_UNSUPPORTED_SCOPE_MESSAGE } from './validate'

/**
 * Health check for notification recipient configuration:
 *   1. The app is not configured at the unsupported "group" scope
 *   2. SentinelOne API reachability + credential/scope validity (a scoped list)
 *   3. Every declared recipient (by email) still exists at the scope
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 's1_credential', passed: false, message: built.error }] }
  }
  const { client, consoleUrl } = built
  if (!client.hasScope) {
    return { healthy: false, score: 0, checks: [{ name: 's1_scope', passed: false, message: MISSING_SCOPE_MESSAGE }] }
  }
  if (client.currentScope === 'group') {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 's1_scope', passed: false, message: RECIPIENTS_UNSUPPORTED_SCOPE_MESSAGE }],
    }
  }

  const specs = extractRecipientSpecs(ctx.canvas).filter((s) => s.email)

  const reachable = await timedCheck('s1_reachable', async () => {
    const live = await listRecipients(client)
    return { message: `SentinelOne reachable at ${consoleUrl} (${client.currentScope} scope)`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const emails = new Set(reachable.live.filter((r) => r.email).map((r) => recipientKey(r.email as string)))
    for (const spec of specs) {
      const present = emails.has(recipientKey(spec.email))
      checks.push({
        name: `recipient:${spec.email}`,
        passed: present,
        message: present ? `Recipient "${spec.email}" is present` : `Recipient "${spec.email}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: import('./validate').LiveRecipient[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: import('./validate').LiveRecipient[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
