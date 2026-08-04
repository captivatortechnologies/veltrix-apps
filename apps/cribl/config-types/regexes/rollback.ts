import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/criblRecordEntities'
import { REGEX } from './_shared'

/** Roll back a Regex Library deploy — restore prior entries or delete created ones. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, REGEX)
}
