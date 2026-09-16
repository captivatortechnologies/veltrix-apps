import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'

/**
 * Drift for hash exceptions is NOT ASSERTED: the Cortex XDR public API exposes no
 * endpoint to list or read hash exceptions, so the app cannot compare declared
 * against live state. Rather than raise false drift, this handler always reports
 * no drift. Best-effort read-only — there is nothing readable to compare.
 *
 * VERIFY against live Cortex XDR — if a list/get endpoint is ever exposed, read
 * it here and diff hash membership + list type.
 */
export default async function driftDetect(_ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  // `checked: false` (SDK 3.9.0): this handler cannot read the live state, so
  // it makes no claim. Without it, `hasDrift: false` reads as a positive
  // assurance and the platform marks outstanding drift for this component
  // resolved with `drift_cleared` — turning "could not look" into "looked and
  // it is fine", and clearing real drift on every scheduled run.
  return { hasDrift: false, diffs, checked: false }
}
