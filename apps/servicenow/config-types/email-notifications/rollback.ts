import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Undo an email-notifications deploy — delete created notifications, restore updated ones. */
export default function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackTable(ctx, spec)
}
