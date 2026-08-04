import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/criblRecordEntities'
import { EVENT_BREAKER } from './_shared'

/** Roll back an Event Breaker Rulesets deploy — restore prior rules or delete created ones. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, EVENT_BREAKER)
}
