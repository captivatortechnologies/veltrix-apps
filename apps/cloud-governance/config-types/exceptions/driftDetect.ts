import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { driftResult, missingDiff, unreadableDrift } from '../lib/drift'
import { resolveStore } from '../lib/store'
import { inspectExceptions } from './_shared'

/** Canvas is the source of truth: a missing exception or a changed reason, approver or expiry is drift. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const store = resolveStore(ctx)
  if (!store) return unreadableDrift()

  const diffs: DriftDiff[] = []
  for (const { expected, stored } of await inspectExceptions(store, { canvas: ctx.deployedConfig }, new Date())) {
    const scope = `${expected.policy}/${expected.resourceId}`
    if (!stored) {
      diffs.push(missingDiff(scope, 'exception'))
      continue
    }
    if (stored.reason !== expected.reason) diffs.push({ field: `${scope}.reason`, expected: expected.reason, actual: stored.reason, severity: 'warning' })
    if (stored.approver !== expected.approver) diffs.push({ field: `${scope}.approver`, expected: expected.approver, actual: stored.approver, severity: 'warning' })
    if (Date.parse(stored.expiresAt) !== Date.parse(expected.expiresAt)) {
      diffs.push({ field: `${scope}.expiresAt`, expected: expected.expiresAt, actual: stored.expiresAt, severity: 'warning' })
    }
  }
  return driftResult(diffs)
}
