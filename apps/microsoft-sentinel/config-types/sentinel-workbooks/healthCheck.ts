import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { findWorkbookByDisplayName, listSentinelWorkbooks, workspaceSourceId, type LiveWorkbook } from './deploy'
import { extractWorkbookSpecs } from './validate'

/**
 * Health check for workbooks:
 *   1. ARM reachability + token/permission validity (a workbooks list)
 *   2. Every declared workbook still exists (matched by display name + workspace)
 * Score is the percentage of passed checks (0–100). Content is not fetched here
 * (canFetchContent=false) — presence is enough for the health probe.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'sentinel_credential', passed: false, message: built.error }] }
  }
  const { client, armHost } = built

  const start = Date.now()
  let live: LiveWorkbook[] | null = null
  try {
    live = await listSentinelWorkbooks(client, false)
    checks.push({ name: 'arm_reachable', passed: true, message: `Azure Resource Manager reachable at ${armHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'arm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const sourceId = workspaceSourceId(client)
    for (const spec of extractWorkbookSpecs(ctx.canvas).filter((s) => s.displayName)) {
      const present = Boolean(findWorkbookByDisplayName(live, spec.displayName, sourceId))
      checks.push({
        name: `workbook:${spec.displayName}`,
        passed: present,
        message: present ? `Workbook "${spec.displayName}" is present` : `Workbook "${spec.displayName}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
