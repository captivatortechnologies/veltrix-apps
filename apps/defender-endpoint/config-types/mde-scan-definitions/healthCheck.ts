// =============================================================================
// Health check: is the Defender scan-definitions API reachable, does each
// declared definition still exist and active-match, and does its scanner
// device still resolve? Score is the percentage of checks passed.
// =============================================================================

import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient } from '../../lib/mde'
import { listScanDefinitions, resolveScannerMachine } from './deploy'
import { extractScanDefinitionSpecs, scanNameKey } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'mde_credential', passed: false, message: built.error }] }
  }
  const { client, apiHost } = built

  const specs = extractScanDefinitionSpecs(ctx.canvas).filter((s) => s.scanName && s.targets.length > 0)

  const start = Date.now()
  let live: Awaited<ReturnType<typeof listScanDefinitions>> | null = null
  try {
    live = await listScanDefinitions(client)
    checks.push({ name: 'mde_reachable', passed: true, message: `Defender scan-definitions API reachable at ${apiHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'mde_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const byKey = new Map(live.filter((d) => d.scanName).map((d) => [scanNameKey(d.scanName as string), d]))
    for (const spec of specs) {
      const found = byKey.get(scanNameKey(spec.scanName))
      checks.push({ name: `scan:${spec.scanName}`, passed: Boolean(found), message: found ? 'Scan definition is present' : 'Scan definition is missing' })

      const resolved = await resolveScannerMachine(client, spec)
      checks.push({
        name: `scanner-device:${spec.scanName}`,
        passed: resolved.ok,
        message: resolved.ok ? 'Scanner device resolves' : `Scanner device did not resolve: ${resolved.error}`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
