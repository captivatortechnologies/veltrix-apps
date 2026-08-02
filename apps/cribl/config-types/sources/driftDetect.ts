import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftEntities } from '../../lib/criblSystemEntities'
import { SOURCE } from './_shared'

/** Detect drift between declared Sources and the live inputs in Cribl. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftEntities(ctx, SOURCE)
}
