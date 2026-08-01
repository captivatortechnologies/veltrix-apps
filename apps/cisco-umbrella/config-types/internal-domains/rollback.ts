import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { rollbackResources } from '../../lib/deployments'
import { INTERNAL_DOMAIN_RESOURCE } from './_shared'

/** Undo an internal-domains deploy (delete created, restore updated). */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  return rollbackResources(ctx, built.client, INTERNAL_DOMAIN_RESOURCE)
}
