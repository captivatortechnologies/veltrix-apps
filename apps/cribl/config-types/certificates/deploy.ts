import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { CERTIFICATE, buildCertificateRecord } from './_shared'

/** Deploy Cribl Certificates (upsert by id) over /api/v1/m/<group>/system/certificates. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, CERTIFICATE, buildCertificateRecord)
}
