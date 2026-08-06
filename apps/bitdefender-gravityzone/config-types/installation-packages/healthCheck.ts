import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getApiKeyDetails } from '../../lib/gravityZoneApi'
import { extractInstallationPackageSpecs, findLivePackage, listAllPackages } from './_shared'

/**
 * Health check for installation package configuration:
 *   1. GravityZone API reachability + API key validity (general.getApiKeyDetails)
 *   2. Every declared packageName still exists as a live package
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'gravityzone_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  try {
    await getApiKeyDetails(client)
    checks.push({ name: 'gravityzone_reachable', passed: true, message: 'GravityZone API reachable and API key accepted.', latencyMs: Date.now() - started })
  } catch (error) {
    checks.push({
      name: 'gravityzone_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'GravityZone API unreachable',
      latencyMs: Date.now() - started,
    })
    return { healthy: false, score: 0, checks }
  }

  const specs = extractInstallationPackageSpecs(ctx.canvas).filter((s) => s.packageName)
  const listStarted = Date.now()
  try {
    const live = await listAllPackages(client)
    for (const spec of specs) {
      const present = Boolean(findLivePackage(live, spec.packageName))
      checks.push({
        name: `installation-package:${spec.packageName}`,
        passed: present,
        message: present ? `Package "${spec.packageName}" is present.` : `Package "${spec.packageName}" is missing.`,
        latencyMs: Date.now() - listStarted,
      })
    }
  } catch (error) {
    checks.push({
      name: 'installation-packages:list',
      passed: false,
      message: error instanceof Error ? error.message : 'Failed to list packages',
      latencyMs: Date.now() - listStarted,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
