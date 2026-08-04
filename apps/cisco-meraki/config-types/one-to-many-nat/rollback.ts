import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { getOneToManyNatRules, putOneToManyNatRules } from '../../lib/merakiApi'
import { rollbackOrderedList } from '../../lib/merakiOrderedList'

/** Roll back one-to-many NAT rules — thin wrapper over the shared ordered-list engine. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return rollbackOrderedList(ctx, { get: getOneToManyNatRules, put: putOneToManyNatRules, resourceLabel: 'one-to-many NAT rules' })
}
