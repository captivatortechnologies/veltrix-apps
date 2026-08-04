import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { CERTIFICATE, buildCertificateRecord } from './_shared'

/** Detect drift between declared Certificates and the live entries in Cribl. The private key is never compared (write-only, see _shared.ts). */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, CERTIFICATE, buildCertificateRecord)
}
