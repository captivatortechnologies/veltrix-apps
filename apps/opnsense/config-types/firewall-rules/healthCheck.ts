import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOpnsenseClient, searchFilterRules } from '../../lib/opnsenseApi'
import { extractFilterRuleSpecs } from './_shared'

/**
 * Health check for OPNsense firewall-rules configuration: API reachability +
 * credential validity (searchRule), then every declared rule's canvas item
 * still has a corresponding live rule (matched via the LAST successful
 * deployment's rollbackData — this config type has no name to check by, see
 * _shared.ts's module doc). Read-only.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'opnsense_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractFilterRuleSpecs(ctx.canvas)
  const started = Date.now()
  let liveUuids = new Set<string>()

  try {
    const live = await searchFilterRules(client)
    liveUuids = new Set(live.map((r) => r.uuid))
    checks.push({
      name: 'opnsense_reachable',
      passed: true,
      message: `Reached the OPNsense API at ${host}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'opnsense_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'searchRule failed',
      latencyMs: Date.now() - started,
    })
  }

  if (checks[0]?.passed) {
    let deployment
    try {
      deployment = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    } catch {
      deployment = null
    }
    const rollbackEntries = (deployment?.rollbackData as { entries?: Array<{ itemId: string; uuid?: string }> } | undefined)?.entries ?? []
    const uuidByItemId = new Map(rollbackEntries.filter((e) => e.uuid).map((e) => [e.itemId, e.uuid as string]))

    for (const spec of specs) {
      const uuid = uuidByItemId.get(spec.itemId)
      const present = !!uuid && liveUuids.has(uuid)
      const label = spec.description || spec.itemId
      checks.push({
        name: `rule:${label}`,
        passed: present,
        message: present ? `Rule "${label}" is present` : `Rule "${label}" is missing or was never deployed`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
