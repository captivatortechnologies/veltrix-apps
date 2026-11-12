import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'

export default async function driftDetect(_ctx: DriftContext): Promise<DriftResult> {
  return { hasDrift: false, diffs: [], checked: false }
}
