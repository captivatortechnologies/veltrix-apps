import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getOneToManyNatRules, putOneToManyNatRules } from '../../lib/merakiApi'
import { deployOrderedList } from '../../lib/merakiOrderedList'
import { normalizeOneToManyNatRule } from './_shared'

/** Deploy one-to-many NAT rules — thin wrapper over the shared ordered-list engine. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployOrderedList(
    ctx,
    { get: getOneToManyNatRules, put: putOneToManyNatRules, resourceLabel: 'one-to-many NAT rules' },
    normalizeOneToManyNatRule,
  )
}
