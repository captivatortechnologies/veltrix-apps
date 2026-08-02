import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftEntities } from '../../lib/criblSystemEntities'
import { DESTINATION } from './_shared'

/** Detect drift between declared Destinations and the live outputs in Cribl. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftEntities(ctx, DESTINATION)
}
