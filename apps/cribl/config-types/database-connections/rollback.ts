import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackRecords } from '../../lib/criblRecordEntities'
import { DATABASE_CONNECTION } from './_shared'

/**
 * Roll back a Database Connections deploy — a newly-created connection is
 * deleted; an UPDATED connection is left as-is (its credential fields are
 * write-only, see _shared.ts).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackRecords(ctx, DATABASE_CONNECTION)
}
