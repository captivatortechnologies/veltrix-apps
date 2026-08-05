import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { listAuthRecords } from './deploy'
import { extractAuthRecordSpecs, type LiveAuthRecord } from './validate'

/**
 * Health check for authentication record configuration:
 *   1. Qualys platform reachability + credential validity (one list per declared type)
 *   2. Every declared record still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'qualys_credential', passed: false, message: built.error }] }
  }
  const { client, platformUrl } = built

  const specs = extractAuthRecordSpecs(ctx.canvas).filter((s) => s.recordType && s.title)
  const byType = new Map<string, Map<string, LiveAuthRecord>>()

  const start = Date.now()
  let reachable = true
  try {
    for (const recordType of new Set(specs.map((s) => s.recordType))) {
      const live = await listAuthRecords(client, recordType)
      byType.set(recordType, new Map(live.map((r) => [r.title.trim().toLowerCase(), r])))
    }
    checks.push({
      name: 'qualys_reachable',
      passed: true,
      message: `Qualys platform reachable at ${platformUrl}`,
      latencyMs: Date.now() - start,
    })
  } catch (error) {
    reachable = false
    checks.push({
      name: 'qualys_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (reachable) {
    for (const spec of specs) {
      const label = `${spec.recordType}:${spec.title}`
      const present = byType.get(spec.recordType)?.has(spec.title.trim().toLowerCase()) ?? false
      checks.push({
        name: `auth_record:${label}`,
        passed: present,
        message: present ? `Authentication record "${label}" is present` : `Authentication record "${label}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
