import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { KEY, buildKeyRecord } from './_shared'

/** Detect drift between declared Key metadata and the live entries in Cribl. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, KEY, buildKeyRecord)
}
