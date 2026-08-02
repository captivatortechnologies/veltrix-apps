import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackEntities } from '../../lib/criblSystemEntities'
import { SOURCE } from './_shared'

/** Roll back a Sources deploy — restore prior inputs or delete created ones. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackEntities(ctx, SOURCE)
}
