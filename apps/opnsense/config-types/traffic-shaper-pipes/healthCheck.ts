import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { searchPipes, type LivePipe } from '../../lib/trafficShaperApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { extractPipeSpecs, pipeKey } from './_shared'

/**
 * Health check for OPNsense traffic-shaper-pipes configuration: API
 * reachability + credential validity (searchPipes), then every declared
 * pipe (by description) still exists. Read-only.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'opnsense_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractPipeSpecs(ctx.canvas).filter((s) => s.description)
  let live: LivePipe[] = []
  const started = Date.now()

  try {
    live = await searchPipes(client)
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
      message: error instanceof Error ? error.message : 'searchPipes failed',
      latencyMs: Date.now() - started,
    })
  }

  if (checks[0]?.passed) {
    const keys = new Set(live.filter((p) => p.description).map((p) => pipeKey(p.description as string)))
    for (const spec of specs) {
      const present = keys.has(pipeKey(spec.description))
      checks.push({
        name: `pipe:${spec.description}`,
        passed: present,
        message: present ? `Pipe "${spec.description}" is present` : `Pipe "${spec.description}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
