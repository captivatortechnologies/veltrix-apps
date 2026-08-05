import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/soarRecordEntities'
import { CONTAINER_STATUS } from './_shared'

/**
 * Undo a Container Statuses deploy: a newly-created status is deleted via
 * DELETE /rest/container_status/<id>; an updated one is restored to its prior
 * body. SOAR requires at least one active status per category — a rollback
 * that would leave a category empty surfaces as a clear failure from SOAR.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, CONTAINER_STATUS)
}
