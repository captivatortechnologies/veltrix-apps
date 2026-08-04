import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { SECRET, buildSecretRecord } from './_shared'

/** Detect drift between declared Secrets and the live entries in Cribl. Secret material is never compared (write-only, see _shared.ts). */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, SECRET, buildSecretRecord)
}
