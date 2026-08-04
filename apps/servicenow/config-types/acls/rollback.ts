import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Undo an ACLs deploy — delete created rules, restore updated ones. */
export default function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackTable(ctx, spec)
}
