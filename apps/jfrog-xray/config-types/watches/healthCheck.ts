import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { WATCHES_PATH } from './deploy'
import { extractWatchSpecs, findWatch, type XrayWatch } from './_shared'

/**
 * Health check for the watches configuration:
 *   1. Xray reachability + credential validity (`GET /api/v2/watches`)
 *   2. Every declared watch (by name) still exists in the tenant
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'xray_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractWatchSpecs(ctx.canvas).filter((s) => s.name)

  const started = Date.now()
  let live: XrayWatch[] | null = null
  try {
    live = await client.getJson<XrayWatch[]>(WATCHES_PATH)
    checks.push({ name: 'xray_reachable', passed: true, message: `Xray reachable at ${host}`, latencyMs: Date.now() - started })
  } catch (error) {
    checks.push({
      name: 'xray_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - started,
    })
  }

  if (live) {
    for (const spec of specs) {
      const found = findWatch(live, spec.name)
      const present = Boolean(found)
      checks.push({
        name: `watch:${spec.name}`,
        passed: present,
        message: present ? `Watch "${spec.name}" is present` : `Watch "${spec.name}" is missing`,
      })
      if (found) {
        const liveActive = found.general_data?.active !== false
        if (liveActive !== spec.active) {
          checks.push({
            name: `watch:${spec.name}:active`,
            passed: false,
            message: `Watch "${spec.name}" is ${liveActive ? 'active' : 'inactive'} but the configuration declares ${spec.active ? 'active' : 'inactive'}`,
          })
        }
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
