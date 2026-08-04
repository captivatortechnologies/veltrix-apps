import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { REGEX, buildRegexRecord } from './_shared'

/** Deploy Cribl Regex Library entries (upsert by id) over /api/v1/m/<group>/lib/regex. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, REGEX, buildRegexRecord)
}
