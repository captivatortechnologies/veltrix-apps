import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { getOneToOneNatRules, putOneToOneNatRules } from '../../lib/merakiApi'
import { rollbackOrderedList } from '../../lib/merakiOrderedList'

/** Roll back one-to-one NAT rules — thin wrapper over the shared ordered-list engine. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackOrderedList(ctx, { get: getOneToOneNatRules, put: putOneToOneNatRules, resourceLabel: 'one-to-one NAT rules' })
}
