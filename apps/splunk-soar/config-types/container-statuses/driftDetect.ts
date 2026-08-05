import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/soarRecordEntities'
import { CONTAINER_STATUS, buildStatusRecord } from './_shared'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, CONTAINER_STATUS, buildStatusRecord)
}
