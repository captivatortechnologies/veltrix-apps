import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { rollbackResources } from '../../lib/deployments'
import { INTERNAL_NETWORK_SUBNET_RESOURCE } from './_shared'

/** Undo an internal-network-subnets deploy from rollbackData (delete created,
 * restore updated — using the exact numeric ids captured at deploy time, so no
 * re-resolution of association names is needed). */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  return rollbackResources(ctx, built.client, INTERNAL_NETWORK_SUBNET_RESOURCE)
}
