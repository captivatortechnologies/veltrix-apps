import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/criblRecordEntities'
import { SECRET } from './_shared'

/**
 * Roll back a Secrets deploy — a newly-created secret is deleted; an UPDATED
 * secret is left as-is (its material is write-only, see _shared.ts).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, SECRET)
}
