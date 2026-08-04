import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getOneToOneNatRules, putOneToOneNatRules } from '../../lib/merakiApi'
import { deployOrderedList } from '../../lib/merakiOrderedList'
import { normalizeOneToOneNatRule } from './_shared'

/** Deploy one-to-one NAT rules — thin wrapper over the shared ordered-list engine. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployOrderedList(
    ctx,
    { get: getOneToOneNatRules, put: putOneToOneNatRules, resourceLabel: 'one-to-one NAT rules' },
    normalizeOneToOneNatRule,
  )
}
