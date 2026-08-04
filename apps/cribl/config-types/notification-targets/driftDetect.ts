import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftEntities } from '../../lib/criblSystemEntities'
import { NOTIFICATION_TARGET } from './_shared'

/** Detect drift between declared Notification Targets and the live targets in Cribl. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftEntities(ctx, NOTIFICATION_TARGET)
}
