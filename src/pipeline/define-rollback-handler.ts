import type { RollbackContext, RollbackResult } from '../types/pipeline'

/**
 * Define a rollback handler for a configuration type.
 */
export function defineRollbackHandler(
  handler: (ctx: RollbackContext) => Promise<RollbackResult>,
): (ctx: RollbackContext) => Promise<RollbackResult> {
  return handler
}
