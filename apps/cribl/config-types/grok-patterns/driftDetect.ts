import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { GROK, buildGrokRecord } from './_shared'

/** Detect drift between declared Grok Pattern Files and the live files in Cribl. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, GROK, buildGrokRecord)
}
