import type { DriftContext, DriftResult } from '../types/pipeline'

/**
 * Define a drift detection handler for a configuration type.
 */
export function defineDriftDetector(
  handler: (ctx: DriftContext) => Promise<DriftResult>,
): (ctx: DriftContext) => Promise<DriftResult> {
  return handler
}
