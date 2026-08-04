import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Drift = declared assignment-rule fields vs the live sysrule_assignment record. Read-only, best-effort. */
export default function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftTable(ctx, spec)
}
