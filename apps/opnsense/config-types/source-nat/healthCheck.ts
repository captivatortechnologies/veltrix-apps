import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOpnsenseClient, getSourceNatMode, searchSourceNatRules } from '../../lib/opnsenseApi'
import { extractSourceNatRuleSpecs, modeHonorsManualRules } from './_shared'

/**
 * Health check for OPNsense source-nat configuration: API reachability +
 * credential validity (searchRule), every declared rule's canvas item still
 * has a corresponding live rule (matched via the last successful
 * deployment's rollbackData — no name to check by), and a non-fatal check
 * that the outbound NAT mode actually honors manual rules (see _shared.ts's
 * `modeHonorsManualRules` / lib/opnsenseApi.ts's `getSourceNatMode` docs).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'opnsense_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractSourceNatRuleSpecs(ctx.canvas)
  const started = Date.now()
  let liveUuids = new Set<string>()

  try {
    const live = await searchSourceNatRules(client)
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

    if (specs.length > 0) {
      const mode = await getSourceNatMode(client).catch(() => null)
      if (mode !== null) {
        const honored = modeHonorsManualRules(mode)
        checks.push({
          name: 'snat_mode',
          passed: honored,
          message: honored
            ? `Outbound NAT mode "${mode}" honors manual rules`
            : `Outbound NAT mode is "${mode}" — manual rules are staged and applied but have NO real effect until it is set to Hybrid or Manual`,
        })
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
