import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/soarRecordEntities'
import { CEF, buildCefRecord } from './_shared'

/** Deploy CEF Custom Fields (upsert by name) over GET/POST /rest/cef. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, CEF, buildCefRecord)
}
