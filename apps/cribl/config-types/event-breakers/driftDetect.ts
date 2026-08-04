import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { EVENT_BREAKER, buildEventBreakerRecord } from './_shared'

/** Detect drift between declared Event Breaker Rulesets and the live rulesets in Cribl. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, EVENT_BREAKER, buildEventBreakerRecord)
}
