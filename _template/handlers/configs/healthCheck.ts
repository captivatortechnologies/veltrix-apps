// =============================================================================
// HEALTH CHECK HANDLER
//
// Called during and after deployment to verify the tool is healthy.
// Run whatever checks make sense for your tool: API reachability,
// service status, log errors, query results, etc.
//
// Return { healthy: true, score: 100 } when everything is good.
// Return { healthy: false, score: X } to trigger auto-rollback.
// Include individual check details for the deployment log.
// =============================================================================

import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity } = ctx
  const checks: HealthCheckResult['checks'] = []

  // Example Check 1: API reachability
  // if (connectivity?.httpsUrl) {
  //   try {
  //     const start = Date.now()
  //     const response = await fetch(`${connectivity.httpsUrl}/health`)
  //     const latencyMs = Date.now() - start
  //
  //     checks.push({
  //       name: 'api_reachable',
  //       passed: response.ok,
  //       message: response.ok ? 'API is reachable' : `API returned ${response.status}`,
  //       latencyMs,
  //     })
  //   } catch (err) {
  //     checks.push({
  //       name: 'api_reachable',
  //       passed: false,
  //       message: `API unreachable: ${err instanceof Error ? err.message : 'unknown error'}`,
  //     })
  //   }
  // }

  // Example Check 2: Service status
  // checks.push({
  //   name: 'service_running',
  //   passed: true,
  //   message: 'Service is running',
  // })

  // Example Check 3: Config applied
  // checks.push({
  //   name: 'config_applied',
  //   passed: true,
  //   message: 'Configuration is active',
  // })

  // Placeholder checks
  checks.push({
    name: 'component_reachable',
    passed: true,
    message: `${component.hostname} is reachable`,
    latencyMs: 50,
  })

  const allPassed = checks.every((c) => c.passed)
  const score = checks.length > 0
    ? (checks.filter((c) => c.passed).length / checks.length) * 100
    : 100

  return {
    healthy: allPassed,
    score,
    checks,
  }
}
