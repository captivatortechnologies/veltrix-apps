import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { LOOKUP, buildLookupRecord } from './_shared'

/** Detect drift between declared Lookups and the live tables in Cribl. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, LOOKUP, buildLookupRecord)
}
