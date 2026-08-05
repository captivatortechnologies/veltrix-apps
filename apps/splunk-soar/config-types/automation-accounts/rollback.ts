import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/soarRecordEntities'
import { AUTOMATION_ACCOUNT } from './_shared'

/**
 * Undo an Automation Accounts deploy: a newly-created account is deleted via
 * DELETE /rest/ph_user/<id>; an updated one is restored to its prior body
 * (never including a password — this type never captured or sent one).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, AUTOMATION_ACCOUNT)
}
