import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Undo a UI-actions deploy — delete created actions, restore updated ones. */
export default function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackTable(ctx, spec)
}
