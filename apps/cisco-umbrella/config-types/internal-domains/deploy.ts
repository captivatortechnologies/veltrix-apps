import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { deployResources } from '../../lib/deployments'
import { INTERNAL_DOMAIN_RESOURCE, extractInternalDomainSpecs } from './_shared'

/** Deploy Umbrella internal domains (create/update/reconcile) from the canvas. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }

  const specs = extractInternalDomainSpecs(ctx.canvas).filter((s) => s.domain)
  return deployResources(ctx, built.client, specs, INTERNAL_DOMAIN_RESOURCE)
}
