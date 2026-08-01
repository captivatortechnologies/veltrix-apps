import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { rollbackResources } from '../../lib/deployments'
import { NETWORK_RESOURCE } from './_shared'

/** Undo a networks deploy from rollbackData (delete created, restore updated). */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  return rollbackResources(ctx, built.client, NETWORK_RESOURCE)
}
