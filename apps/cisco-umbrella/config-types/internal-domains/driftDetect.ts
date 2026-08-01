import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { driftResources } from '../../lib/deployments'
import { INTERNAL_DOMAIN_RESOURCE, extractInternalDomainSpecs } from './_shared'

/** Drift for internal domains: absent declared domain = critical; field mismatch = warning. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }

  const specs = extractInternalDomainSpecs(ctx.deployedConfig).filter((s) => s.domain)
  return driftResources(ctx, built.client, specs, INTERNAL_DOMAIN_RESOURCE)
}
