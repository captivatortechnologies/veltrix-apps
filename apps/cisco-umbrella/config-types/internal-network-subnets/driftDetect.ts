import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { driftResources } from '../../lib/deployments'
import { INTERNAL_NETWORK_SUBNET_RESOURCE, extractInternalNetworkSubnetSpecs, resolveAssociations } from './_shared'

/**
 * Drift for internal network subnets: a declared subnet whose association
 * (Site/Network/Tunnel) can no longer be resolved is reported as critical
 * drift (its target disappeared); a resolvable subnet that is absent from
 * Umbrella, or present with different fields, follows the standard
 * deployment-resource drift rules. Best-effort and read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractInternalNetworkSubnetSpecs(ctx.deployedConfig).filter((s) => s.name)
  const { resolved, failures } = await resolveAssociations(client, specs)

  const diffs: DriftResult['diffs'] = failures.map((message) => ({
    field: 'associationName',
    expected: 'resolvable',
    actual: message,
    severity: 'critical',
  }))

  const base = await driftResources(ctx, client, resolved, INTERNAL_NETWORK_SUBNET_RESOURCE)
  diffs.push(...base.diffs)
  return { hasDrift: diffs.length > 0, diffs }
}
