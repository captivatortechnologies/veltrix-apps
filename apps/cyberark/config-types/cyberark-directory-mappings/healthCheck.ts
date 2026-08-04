import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { mapMappings, resolveDirectoryId } from './deploy'
import { extractDirectoryMappingSpecs, type LiveDirectoryMapping } from './validate'

/**
 * Health check for directory-mapping configuration:
 *   1. PVWA reachability + logon (a Directories list + Mappings per directory)
 *   2. Every declared mapping (by directory + name) still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'cyberark_credential', passed: false, message: built.error }] }
  }
  const { client, pvwaUrl } = built

  const specs = extractDirectoryMappingSpecs(ctx.canvas).filter((s) => s.directoryName && s.mappingName)
  const start = Date.now()
  const directoryIds = new Map<string, string>()
  const mappingsByDirectory = new Map<string, Map<string, LiveDirectoryMapping>>()
  let reachable = false

  try {
    for (const spec of specs) {
      const directoryId = await resolveDirectoryId(client, spec.directoryName, directoryIds)
      if (!mappingsByDirectory.has(directoryId)) mappingsByDirectory.set(directoryId, await mapMappings(client, directoryId))
    }
    reachable = true
    checks.push({ name: 'cyberark_reachable', passed: true, message: `PVWA reachable at ${pvwaUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'cyberark_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (reachable) {
    for (const spec of specs) {
      const directoryId = directoryIds.get(spec.directoryName.toLowerCase())
      const present = !!directoryId && !!mappingsByDirectory.get(directoryId)?.has(spec.mappingName.toLowerCase())
      checks.push({
        name: `mapping:${spec.mappingName}@${spec.directoryName}`,
        passed: present,
        message: present ? `Mapping "${spec.mappingName}" @ "${spec.directoryName}" is present` : `Mapping "${spec.mappingName}" @ "${spec.directoryName}" is missing`,
      })
    }
  }

  await client.logoff()
  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
