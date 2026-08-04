import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { getOneToManyNatRules } from '../../lib/merakiApi'
import { driftOrderedList } from '../../lib/merakiOrderedList'
import { normalizeOneToManyNatRule } from './_shared'

/** Drift for one-to-many NAT rules — thin wrapper over the shared ordered-list engine. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftOrderedList(ctx, { get: getOneToManyNatRules }, normalizeOneToManyNatRule)
}
