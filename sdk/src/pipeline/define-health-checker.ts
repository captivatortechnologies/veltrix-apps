import type { HealthCheckContext, HealthCheckResult } from '../types/pipeline'

/**
 * Define a health check handler for a configuration type.
 */
export function defineHealthChecker(
  handler: (ctx: HealthCheckContext) => Promise<HealthCheckResult>,
): (ctx: HealthCheckContext) => Promise<HealthCheckResult> {
  return handler
}
