import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/soarRecordEntities'
import { CEF } from './_shared'

/**
 * Undo a Custom Fields deploy: a newly-created CEF field is deleted via
 * DELETE /rest/cef/<id>; an updated one is restored to its prior body.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, CEF)
}
