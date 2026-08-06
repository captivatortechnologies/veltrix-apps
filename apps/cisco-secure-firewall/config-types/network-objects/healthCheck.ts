import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient } from '../../lib/fmc'
import { extractNetworkObjectSpecs, pathForKind } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'fmc_credential', passed: false, message: built.error }] }
  }
  const { client, fmcUrl } = built

  const specs = extractNetworkObjectSpecs(ctx.canvas).filter((s) => s.name)
  const kinds = specs.length > 0 ? [...new Set(specs.map((s) => s.kind))] : ['host']

  for (const kind of kinds) {
    const start = Date.now()
    const listed = await client.list(pathForKind(kind))
    if (!listed.ok) {
      checks.push({
        name: `fmc_reachable:${kind}`,
        passed: false,
        message: `FMC list failed for ${kind} objects (HTTP ${listed.status})`,
        latencyMs: Date.now() - start,
      })
      continue
    }
    checks.push({
      name: `fmc_reachable:${kind}`,
      passed: true,
      message: `FMC reachable at ${fmcUrl} for ${kind} objects`,
      latencyMs: Date.now() - start,
    })

    const liveNames = new Set(listed.items.map((i) => (i.name ?? '').toLowerCase()).filter(Boolean))
    for (const spec of specs.filter((s) => s.kind === kind)) {
      const present = liveNames.has(spec.name.toLowerCase())
      checks.push({
        name: `network-object:${spec.name}`,
        passed: present,
        message: present ? `"${spec.name}" is present` : `"${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
