import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackEntities } from '../../lib/criblSystemEntities'
import { DESTINATION } from './_shared'

/** Roll back a Destinations deploy — restore prior outputs or delete created ones. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackEntities(ctx, DESTINATION)
}
