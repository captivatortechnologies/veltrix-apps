import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/soarRecordEntities'
import { SEVERITY, buildSeverityRecord } from './_shared'

/** Deploy Severities (upsert by name) over GET/POST /rest/severity. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, SEVERITY, buildSeverityRecord)
}
