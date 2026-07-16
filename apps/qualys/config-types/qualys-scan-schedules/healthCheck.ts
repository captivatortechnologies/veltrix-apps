import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { listSchedules } from './deploy'
import { extractScheduleSpecs, scheduleKey, type LiveSchedule } from './validate'

/**
 * Health check for scan schedule configuration:
 *   1. Qualys platform reachability + credential validity (a paged schedule list)
 *   2. Every declared scan schedule still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'qualys_credential', passed: false, message: built.error }] }
  }
  const { client, platformUrl } = built

  const start = Date.now()
  let live: LiveSchedule[] | null = null
  try {
    live = await listSchedules(client)
    checks.push({
      name: 'qualys_reachable',
      passed: true,
      message: `Qualys platform reachable at ${platformUrl}`,
      latencyMs: Date.now() - start,
    })
  } catch (error) {
    checks.push({
      name: 'qualys_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (live) {
    const keys = new Set(live.map((s) => scheduleKey({ scanTitle: s.title })))
    for (const spec of extractScheduleSpecs(ctx.canvas).filter((s) => s.scanTitle)) {
      const present = keys.has(scheduleKey(spec))
      checks.push({
        name: `scan_schedule:${spec.scanTitle}`,
        passed: present,
        message: present ? `Scan schedule "${spec.scanTitle}" is present` : `Scan schedule "${spec.scanTitle}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
