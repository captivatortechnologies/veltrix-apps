import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackEntities } from '../../lib/criblSystemEntities'
import { NOTIFICATION_TARGET } from './_shared'

/** Roll back a Notification Targets deploy — restore prior targets or delete created ones. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackEntities(ctx, NOTIFICATION_TARGET)
}
