import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/criblRecordEntities'
import { HMAC_FUNCTION } from './_shared'

/** Roll back an HMAC Functions deploy — restore prior entries or delete created ones. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, HMAC_FUNCTION)
}
