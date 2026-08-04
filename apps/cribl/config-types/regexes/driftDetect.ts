import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { REGEX, buildRegexRecord } from './_shared'

/** Detect drift between declared Regex Library entries and the live entries in Cribl. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, REGEX, buildRegexRecord)
}
