import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Drift = declared client-script fields vs the live sys_script_client record. Read-only, best-effort. */
export default function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftTable(ctx, spec)
}
