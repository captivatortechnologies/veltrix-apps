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
  return { hasDrift: false, diffs }
}
