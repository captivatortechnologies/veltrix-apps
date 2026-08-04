import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Drift = declared notification fields vs the live sysevent_email_action record. Read-only, best-effort. */
export default function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftTable(ctx, spec)
}
