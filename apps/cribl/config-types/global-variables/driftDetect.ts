import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { GLOBAL_VAR, buildGlobalVarRecord } from './_shared'

/**
 * Detect drift between declared Global Variables and the live entries in
 * Cribl. See _shared.ts for the documented `encryptedString` caveat.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, GLOBAL_VAR, buildGlobalVarRecord)
}
