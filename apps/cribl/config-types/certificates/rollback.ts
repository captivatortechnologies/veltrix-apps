import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/criblRecordEntities'
import { CERTIFICATE } from './_shared'

/**
 * Roll back a Certificates deploy — a newly-created certificate is deleted; an
 * UPDATED certificate is left as-is (its private key is write-only, see
 * _shared.ts).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, CERTIFICATE)
}
