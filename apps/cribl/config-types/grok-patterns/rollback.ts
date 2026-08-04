import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/criblRecordEntities'
import { GROK } from './_shared'

/** Roll back a Grok Pattern Files deploy — restore prior content or delete created ones. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, GROK)
}
