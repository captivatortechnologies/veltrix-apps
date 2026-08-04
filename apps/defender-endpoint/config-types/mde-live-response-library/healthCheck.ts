// =============================================================================
// Health check: is the Defender library files API reachable, and does each
// declared file still exist with the declared content (by SHA-256)? Score is
// the percentage of checks passed.
// =============================================================================

import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient } from '../../lib/mde'
import { contentSha256 } from './driftDetect'
import { listLibraryFiles } from './deploy'
import { extractLibraryFileSpecs, fileNameKey } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'mde_credential', passed: false, message: built.error }] }
  }
  const { client, apiHost } = built

  const specs = extractLibraryFileSpecs(ctx.canvas).filter((s) => s.fileName && s.content)

  const start = Date.now()
  let live: Awaited<ReturnType<typeof listLibraryFiles>> | null = null
  try {
    live = await listLibraryFiles(client)
    checks.push({ name: 'mde_reachable', passed: true, message: `Defender library API reachable at ${apiHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'mde_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const byKey = new Map(live.filter((f) => f.fileName).map((f) => [fileNameKey(f.fileName as string), f]))
    for (const spec of specs) {
      const found = byKey.get(fileNameKey(spec.fileName))
      if (!found) {
        checks.push({ name: `file:${spec.fileName}`, passed: false, message: 'File is missing' })
        continue
      }
      const matches = !found.sha256 || found.sha256.toLowerCase() === contentSha256(spec.content).toLowerCase()
      checks.push({ name: `file:${spec.fileName}`, passed: matches, message: matches ? 'Present with matching content' : 'Present but content has drifted' })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
