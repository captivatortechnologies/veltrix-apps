import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { COLLECTOR, buildCollectorRecord } from './_shared'

/** Detect drift between declared Collectors and the live jobs in Cribl. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, COLLECTOR, buildCollectorRecord)
}
