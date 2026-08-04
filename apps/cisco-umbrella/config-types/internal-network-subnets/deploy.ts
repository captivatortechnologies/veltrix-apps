import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { deployResources } from '../../lib/deployments'
import { INTERNAL_NETWORK_SUBNET_RESOURCE, extractInternalNetworkSubnetSpecs, resolveAssociations } from './_shared'

/**
 * Deploy Umbrella internal network subnets (create/update/reconcile). Each
 * declared subnet's association (Site/Network/Tunnel NAME) is resolved to
 * Umbrella's opaque id first; a subnet whose association can't be resolved is
 * skipped and reported as a failure rather than deployed with a bad reference.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractInternalNetworkSubnetSpecs(ctx.canvas).filter((s) => s.name)
  const { resolved, failures } = await resolveAssociations(client, specs)

  const result = await deployResources(ctx, client, resolved, INTERNAL_NETWORK_SUBNET_RESOURCE)
  if (failures.length === 0) return result

  const prefix = `${failures.length} subnet(s) could not be deployed — ${failures.join('; ')}.`
  return {
    success: false,
    message: result.message ? `${prefix} ${result.message}` : prefix,
    rollbackData: result.rollbackData,
  }
}
