import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/soarRecordEntities'
import { AUTOMATION_ACCOUNT, buildAccountRecord } from './_shared'

/** Deploy Automation Accounts (upsert by username) over GET/POST /rest/ph_user. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, AUTOMATION_ACCOUNT, buildAccountRecord)
}
