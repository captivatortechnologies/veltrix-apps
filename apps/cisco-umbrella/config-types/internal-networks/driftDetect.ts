import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { driftResources } from '../../lib/deployments'
import { NETWORK_RESOURCE, extractNetworkSpecs } from './_shared'

/** Drift for networks: absent declared network = critical; field mismatch = warning. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }

  const specs = extractNetworkSpecs(ctx.deployedConfig).filter((s) => s.name)
  return driftResources(ctx, built.client, specs, NETWORK_RESOURCE)
}
