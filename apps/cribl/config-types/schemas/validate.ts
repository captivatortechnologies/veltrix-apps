import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { SCHEMA, buildSchemaRecord } from './_shared'

/** Validate Schema items — a non-empty id and a `schema` that parses as JSON. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, SCHEMA, buildSchemaRecord)
}
