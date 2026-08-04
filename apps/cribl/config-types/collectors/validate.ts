import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { COLLECTOR, buildCollectorRecord } from './_shared'

/** Validate Collector items — a non-empty id and a `conf` naming a collector backend. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, COLLECTOR, buildCollectorRecord)
}
