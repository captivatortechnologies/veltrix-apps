import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { driftResult, missingDiff, unreadableDrift } from '../lib/drift'
import { resolveStore } from '../lib/store'
import { inspectSchedules } from './_shared'

/** Canvas is the source of truth: compares cron, enabled flag and the clamped enforcement. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const store = resolveStore(ctx)
  if (!store) return unreadableDrift()

  const diffs: DriftDiff[] = []
  for (const { expected, effectiveEnforcement, stored } of await inspectSchedules(store, { canvas: ctx.deployedConfig })) {
    const scope = expected.policy
    if (!stored) {
      diffs.push(missingDiff(scope, 'schedule'))
      continue
    }
    if (stored.cron !== expected.cron) diffs.push({ field: `${scope}.cron`, expected: expected.cron, actual: stored.cron, severity: 'warning' })
    if (stored.enabled !== expected.enabled) diffs.push({ field: `${scope}.enabled`, expected: expected.enabled, actual: stored.enabled, severity: 'warning' })
    if (stored.enforcement !== effectiveEnforcement) {
      diffs.push({ field: `${scope}.enforcement`, expected: effectiveEnforcement, actual: stored.enforcement, severity: 'warning' })
    }
  }
  return driftResult(diffs)
}
