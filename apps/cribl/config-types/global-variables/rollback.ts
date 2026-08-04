import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/criblRecordEntities'
import { GLOBAL_VAR } from './_shared'

/**
 * Roll back a Global Variables deploy — restore prior entries or delete
 * created ones. See _shared.ts for the documented `encryptedString` caveat.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, GLOBAL_VAR)
}
