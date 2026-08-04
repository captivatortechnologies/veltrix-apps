import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/**
 * Undo a system-properties deploy — delete created properties, restore
 * updated ones. Safe for password-type properties: deploy.ts already strips
 * `value` from a password/password2 item's snapshot before this ever runs, so
 * the generic engine's partial PATCH never writes a masked placeholder back
 * over the real secret (see deploy.ts and README).
 */
export default function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackTable(ctx, spec)
}
