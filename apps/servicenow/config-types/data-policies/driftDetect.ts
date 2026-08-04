import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Drift = declared data-policy fields vs the live sys_data_policy2 record. Read-only, best-effort. */
export default function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftTable(ctx, spec)
}
