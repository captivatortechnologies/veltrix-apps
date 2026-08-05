import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/soarRecordEntities'
import { AUTOMATION_ACCOUNT, buildAccountRecord } from './_shared'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, AUTOMATION_ACCOUNT, buildAccountRecord)
}
