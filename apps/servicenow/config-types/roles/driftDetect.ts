import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Drift = declared role fields vs the live sys_user_role record. Read-only, best-effort. */
export default function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftTable(ctx, spec)
}
