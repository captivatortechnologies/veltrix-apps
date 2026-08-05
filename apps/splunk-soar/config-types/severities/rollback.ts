import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/soarRecordEntities'
import { SEVERITY } from './_shared'

/**
 * Undo a Severities deploy: a newly-created severity is deleted via
 * DELETE /rest/severity/<id>; an updated one is restored to its prior body.
 * Deleting a severity does not affect its already-assigned containers/artifacts
 * (SOAR retains historical use even after a severity name is removed).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, SEVERITY)
}
