import type { DeployContext, DeployResult } from '../types/pipeline'

/**
 * Define a deploy handler for a configuration type.
 *
 * @example
 * ```ts
 * import { defineDeployer } from '@veltrix/app-sdk/pipeline'
 *
 * export default defineDeployer(async (ctx) => {
 *   const { component, credential, connectivity, canvas } = ctx
 *   // Push configuration to the tool
 *   return { success: true, message: 'Deployed', rollbackData: previousState }
 * })
 * ```
 */
export function defineDeployer(
  handler: (ctx: DeployContext) => Promise<DeployResult>,
): (ctx: DeployContext) => Promise<DeployResult> {
  return handler
}
