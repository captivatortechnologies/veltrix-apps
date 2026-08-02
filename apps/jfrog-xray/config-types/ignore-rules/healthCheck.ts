import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { ignoreRulePath, IGNORE_RULES_PATH, type IgnoreRuleEntry } from './deploy'
import { extractIgnoreRuleSpecs } from './_shared'

/**
 * Health check for the ignore-rules configuration:
 *   1. Xray reachability + credential validity (`GET /api/v1/ignore_rules`)
 *   2. Every declared item that has a tracked rule id (from the last successful
 *      deployment's rollbackData) still resolves via `GET /api/v1/ignore_rules/{id}`
 * An item never yet deployed (no tracked id) is not checked — it is not a
 * failure, just undeployed content. Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'xray_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const started = Date.now()
  try {
    const res = await client.request('GET', IGNORE_RULES_PATH)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    checks.push({ name: 'xray_reachable', passed: true, message: `Xray reachable at ${host}`, latencyMs: Date.now() - started })
  } catch (error) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'xray_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - started }],
    }
  }

  const specs = extractIgnoreRuleSpecs(ctx.canvas).filter((s) => s.notes && s.itemId)
  const prior = await loadPriorEntries(ctx)
  const byItem = new Map(prior.filter((e) => e.itemId && e.ruleId).map((e) => [e.itemId, e]))

  for (const spec of specs) {
    const entry = byItem.get(spec.itemId as string)
    if (!entry) continue // never deployed — not a health failure
    const res = await client.request('GET', ignoreRulePath(entry.ruleId))
    checks.push({
      name: `ignore-rule:${entry.ruleId}`,
      passed: res.ok,
      message: res.ok ? `Ignore rule "${spec.notes}" is present` : `Ignore rule "${spec.notes}" is missing`,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function loadPriorEntries(ctx: HealthCheckContext): Promise<IgnoreRuleEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: IgnoreRuleEntry[] } | undefined
    return Array.isArray(data?.entries) ? data!.entries : []
  } catch {
    return []
  }
}
