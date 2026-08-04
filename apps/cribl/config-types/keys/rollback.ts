import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/criblRecordEntities'
import { KEY } from './_shared'

/** Roll back a Keys deploy — restore prior metadata or delete created ones. Fully restorable — no secret material is ever managed here. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, KEY)
}
