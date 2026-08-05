import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/soarRecordEntities'
import { CEF, buildCefRecord } from './_shared'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, CEF, buildCefRecord)
}
