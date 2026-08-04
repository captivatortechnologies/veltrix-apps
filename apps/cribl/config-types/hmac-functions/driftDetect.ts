import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { HMAC_FUNCTION, buildHmacFunctionRecord } from './_shared'

/** Detect drift between declared HMAC Functions and the live entries in Cribl. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, HMAC_FUNCTION, buildHmacFunctionRecord)
}
