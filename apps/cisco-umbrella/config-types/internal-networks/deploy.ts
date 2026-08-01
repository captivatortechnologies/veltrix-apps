import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { deployResources } from '../../lib/deployments'
import { NETWORK_RESOURCE, extractNetworkSpecs } from './_shared'

/** Deploy Umbrella networks (create/update/reconcile) from the canvas. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }

  const specs = extractNetworkSpecs(ctx.canvas).filter((s) => s.name)
  return deployResources(ctx, built.client, specs, NETWORK_RESOURCE)
}
