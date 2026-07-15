// =============================================================================
// BYOL usage collector — computes one day of metered usage per infrastructure.
//
//   * node_hours: derived from the app's own state-event log. Self-contained,
//     no external calls: node-hours = Σ (billable-segment hours × node_count).
//   * ingest_gb: from an INJECTED poller (Splunk licenser). Skipped when no
//     poller is supplied or it returns null for an infra — because reaching an
//     infra's Splunk license manager requires the component/connectivity/
//     credential context that BYOL records do not carry yet (follow-up: link a
//     BYOL infra to its license-manager component so ingest can be polled).
//
// Idempotent: re-running a date upserts the same (infra, dimension, day) rows.
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import { listStateEventsForWindow, upsertUsage } from '../db/usage'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Statuses during which an infrastructure accrues node-hours (billable). */
export const BILLABLE_STATUSES = new Set(['running'])

export interface StatePoint {
  status: string
  nodeCount: number
  at: Date
}

/**
 * Node-hours accrued in [dayStart, dayEnd) from a time-ordered state timeline.
 * `events` must be ascending by `at` and SHOULD include the state entering the
 * window (the last event at/before dayStart) so the opening segment is counted.
 * Pure function — the unit-tested core of the meter.
 */
export function computeNodeHours(events: StatePoint[], dayStart: Date, dayEnd: Date): number {
  const start = dayStart.getTime()
  const end = dayEnd.getTime()
  if (events.length === 0 || end <= start) return 0

  // State the infra is in at dayStart = the last event at/before it.
  let state: StatePoint | null = null
  for (const e of events) {
    if (e.at.getTime() <= start) state = e
    else break
  }

  // Change-points strictly inside the window, in order.
  const changes = events.filter((e) => e.at.getTime() > start && e.at.getTime() < end)

  let total = 0
  let segStart = start
  const accrue = (from: number, to: number, s: StatePoint | null) => {
    if (s && BILLABLE_STATUSES.has(s.status) && to > from) {
      total += ((to - from) / HOUR_MS) * s.nodeCount
    }
  }
  for (const change of changes) {
    accrue(segStart, change.at.getTime(), state)
    segStart = change.at.getTime()
    state = change
  }
  accrue(segStart, end, state) // final segment to dayEnd

  return Math.round(total * 10000) / 10000
}

/** Normalize any date to that day's UTC midnight (the canonical period_start). */
export function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** Injectable Splunk ingest poller: GB ingested by an infra on the day, or null. */
export type IngestPoller = (infra: {
  id: string
  customerId: string
  name: string
}) => Promise<number | null>

export interface CollectResult {
  date: string
  infrastructures: number
  nodeHoursRows: number
  ingestRows: number
}

/**
 * Compute + persist one day of usage for every BYOL infrastructure. `dayStart`
 * is normalized to UTC midnight. Pass `ingestPoller` to also record ingest_gb;
 * omit it to record node-hours only (the current default until the Splunk
 * license-manager link exists).
 */
export async function collectForDate(
  db: PlatformDatabaseClient,
  dayStartInput: Date,
  ingestPoller?: IngestPoller,
): Promise<CollectResult> {
  const dayStart = utcDayStart(dayStartInput)
  const dayEnd = new Date(dayStart.getTime() + DAY_MS)

  const infra = await db.$queryRawUnsafe<Array<{ id: string; customer_id: string; name: string }>>(
    'SELECT id, customer_id, name FROM splunk_byol_infrastructure',
  )

  let nodeHoursRows = 0
  let ingestRows = 0
  for (const row of infra) {
    const events = await listStateEventsForWindow(db, row.id, dayStart, dayEnd)
    const nodeHours = computeNodeHours(
      events.map((e) => ({ status: e.status, nodeCount: e.nodeCount, at: e.at })),
      dayStart,
      dayEnd,
    )
    if (nodeHours > 0) {
      await upsertUsage(db, {
        infrastructureId: row.id,
        customerId: row.customer_id,
        dimension: 'node_hours',
        quantity: nodeHours,
        periodStart: dayStart,
        periodEnd: dayEnd,
        source: 'lifecycle',
      })
      nodeHoursRows++
    }

    if (ingestPoller) {
      const gb = await ingestPoller({ id: row.id, customerId: row.customer_id, name: row.name })
      if (gb != null && gb > 0) {
        await upsertUsage(db, {
          infrastructureId: row.id,
          customerId: row.customer_id,
          dimension: 'ingest_gb',
          quantity: gb,
          periodStart: dayStart,
          periodEnd: dayEnd,
          source: 'splunk_licenser',
        })
        ingestRows++
      }
    }
  }

  return {
    date: dayStart.toISOString().slice(0, 10),
    infrastructures: infra.length,
    nodeHoursRows,
    ingestRows,
  }
}
