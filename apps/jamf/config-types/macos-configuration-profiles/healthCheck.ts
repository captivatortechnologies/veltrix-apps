import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { listProfiles } from './deploy'
import { extractProfileSpecs, indexProfilesByName, profileKey } from './validate'
import type { ClassicRef } from '../../lib/jamfClassicXml'

/**
 * Health check for Jamf Pro macOS configuration profile configuration:
 *   1. Jamf Pro Classic API reachability + credential validity (a list)
 *   2. Every declared profile (by name) still exists in the tenant
 * Score is the percentage of passed checks (0–100). Deep field comparison
 * (including the payload) is driftDetect's job.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'jamf_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const specs = extractProfileSpecs(ctx.canvas).filter((s) => s.name)

  const reachable = await timedCheck('jamf_reachable', async () => {
    const live = await listProfiles(client)
    return { message: `Jamf Pro Classic API reachable at ${client.classicBaseUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const byName = indexProfilesByName(reachable.live)
    for (const spec of specs) {
      const present = byName.has(profileKey(spec.name))
      checks.push({
        name: `profile:${spec.name}`,
        passed: present,
        message: present ? `Profile "${spec.name}" is present` : `Profile "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: ClassicRef[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: ClassicRef[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
