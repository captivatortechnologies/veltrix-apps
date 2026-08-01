import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { driftResources } from '../../lib/deployments'
import { SITE_RESOURCE, extractSiteSpecs } from './_shared'

/** Drift for sites: a declared site absent from Umbrella is critical drift. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }

  const specs = extractSiteSpecs(ctx.deployedConfig).filter((s) => s.name)
  return driftResources(ctx, built.client, specs, SITE_RESOURCE)
}
