import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { deployResources } from '../../lib/deployments'
import { SITE_RESOURCE, extractSiteSpecs } from './_shared'

/** Deploy Umbrella sites (create/update/reconcile) from the canvas. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }

  const specs = extractSiteSpecs(ctx.canvas).filter((s) => s.name)
  return deployResources(ctx, built.client, specs, SITE_RESOURCE)
}
