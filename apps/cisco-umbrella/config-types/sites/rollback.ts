import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { rollbackResources } from '../../lib/deployments'
import { SITE_RESOURCE } from './_shared'

/** Undo a sites deploy (delete created, restore renamed). */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  return rollbackResources(ctx, built.client, SITE_RESOURCE)
}
