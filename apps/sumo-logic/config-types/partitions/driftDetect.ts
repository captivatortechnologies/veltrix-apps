import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged } from '../../lib/sumoLogicApi'
import { findPartition, normalizeBool, toRetentionDays, type Partition } from './_shared'

/**
 * Drift for partitions: compare the routing expression, retention period and
 * compliance flag we declare against the live partition in Sumo Logic (matched
 * by name). analyticsTier and name are immutable so they are not diffed.
 * Best-effort — a partition that can't be matched is skipped rather than raising
 * false drift. Read-only: GET /partitions.
 *
 * API: https://www.sumologic.com/help/docs/api/partition-management/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let live: Partition[]
  try {
    live = await listPaged<Partition>(base, 'partitions', headers)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read partitions, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findPartition(live, name)
    if (!match) continue

    const expectedRouting = String(item.fields.routingExpression ?? '').trim()
    const actualRouting = String(match.routingExpression ?? '').trim()
    if (expectedRouting && actualRouting !== expectedRouting) {
      diffs.push({ field: `${name}.routingExpression`, expected: expectedRouting, actual: actualRouting, severity: 'warning' })
    }

    const expectedRetention = toRetentionDays(item.fields.retentionPeriod)
    if (expectedRetention !== undefined && typeof match.retentionPeriod === 'number' && match.retentionPeriod !== expectedRetention) {
      diffs.push({ field: `${name}.retentionPeriod`, expected: expectedRetention, actual: match.retentionPeriod, severity: 'warning' })
    }

    const expectedCompliant = normalizeBool(item.fields.isCompliant)
    const actualCompliant = Boolean(match.isCompliant)
    if (actualCompliant !== expectedCompliant) {
      diffs.push({ field: `${name}.isCompliant`, expected: expectedCompliant, actual: actualCompliant, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
