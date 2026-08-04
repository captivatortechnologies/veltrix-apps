import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { getOneToOneNatRules } from '../../lib/merakiApi'
import { driftOrderedList } from '../../lib/merakiOrderedList'
import { normalizeOneToOneNatRule } from './_shared'

/** Drift for one-to-one NAT rules — thin wrapper over the shared ordered-list engine. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftOrderedList(ctx, { get: getOneToOneNatRules }, normalizeOneToOneNatRule)
}
