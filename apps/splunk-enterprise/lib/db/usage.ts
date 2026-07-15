// =============================================================================
// BYOL usage metering — raw-SQL access to the app-owned
// `splunk_byol_state_event` (lifecycle log) and `splunk_byol_usage` (daily
// metered ledger) tables. Foundation for usage-based cloud billing.
//
// `customerId` references a PLATFORM entity as a plain UUID column; the app
// never foreign-keys across the boundary (same as byol.ts).
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import type { Row } from './mappers'

export type UsageDimension = 'node_hours' | 'ingest_gb'

const toNum = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}
const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)))

// --- State events -----------------------------------------------------------

export interface ByolStateEventDto {
  id: string
  infrastructureId: string
  customerId: string
  status: string
  nodeCount: number
  at: Date
}

export function mapStateEvent(r: Row): ByolStateEventDto {
  return {
    id: r.id,
    infrastructureId: r.infrastructure_id,
    customerId: r.customer_id,
    status: r.status,
    nodeCount: toNum(r.node_count),
    at: toDate(r.at),
  }
}

/** Append a lifecycle state-transition event. Called on every status change. */
export async function recordStateEvent(
  db: PlatformDatabaseClient,
  input: { infrastructureId: string; customerId: string; status: string; nodeCount: number },
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO splunk_byol_state_event (infrastructure_id, customer_id, status, node_count)
     VALUES ($1::uuid, $2::uuid, $3, $4)`,
    input.infrastructureId,
    input.customerId,
    input.status,
    input.nodeCount,
  )
}

/**
 * State events needed to bill [from, to) for one infra: every event inside the
 * window PLUS the single most-recent event before `from` (the state the infra
 * is in when the window opens), ordered ascending by `at`.
 */
export async function listStateEventsForWindow(
  db: PlatformDatabaseClient,
  infrastructureId: string,
  from: Date,
  to: Date,
): Promise<ByolStateEventDto[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `(
       SELECT * FROM splunk_byol_state_event
       WHERE infrastructure_id = $1::uuid AND at < $2
       ORDER BY at DESC LIMIT 1
     )
     UNION ALL
     (
       SELECT * FROM splunk_byol_state_event
       WHERE infrastructure_id = $1::uuid AND at >= $2 AND at < $3
       ORDER BY at ASC
     )`,
    infrastructureId,
    from,
    to,
  )
  return rows.map(mapStateEvent).sort((a, b) => a.at.getTime() - b.at.getTime())
}

// --- Usage ledger -----------------------------------------------------------

export interface ByolUsageDto {
  id: string
  infrastructureId: string
  customerId: string
  dimension: string
  quantity: number
  periodStart: Date
  periodEnd: Date
  source: string
  recordedAt: Date
}

export function mapUsage(r: Row): ByolUsageDto {
  return {
    id: r.id,
    infrastructureId: r.infrastructure_id,
    customerId: r.customer_id,
    dimension: r.dimension,
    quantity: toNum(r.quantity),
    periodStart: toDate(r.period_start),
    periodEnd: toDate(r.period_end),
    source: r.source,
    recordedAt: toDate(r.recorded_at),
  }
}

/** Idempotent daily usage row: one per (infrastructure, dimension, period_start). */
export async function upsertUsage(
  db: PlatformDatabaseClient,
  input: {
    infrastructureId: string
    customerId: string
    dimension: UsageDimension
    quantity: number
    periodStart: Date
    periodEnd: Date
    source?: string
  },
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO splunk_byol_usage
       (infrastructure_id, customer_id, dimension, quantity, period_start, period_end, source)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
     ON CONFLICT (infrastructure_id, dimension, period_start)
     DO UPDATE SET quantity = EXCLUDED.quantity, period_end = EXCLUDED.period_end,
                   source = EXCLUDED.source, recorded_at = now()`,
    input.infrastructureId,
    input.customerId,
    input.dimension,
    input.quantity,
    input.periodStart,
    input.periodEnd,
    input.source ?? 'collector',
  )
}

/** Per-dimension usage totals over [from, to) for a customer (or all tenants). */
export async function aggregateUsage(
  db: PlatformDatabaseClient,
  params: { customerId?: string; from: Date; to: Date },
): Promise<Array<{ customerId: string; dimension: string; quantity: number }>> {
  const args: unknown[] = [params.from, params.to]
  let scope = ''
  if (params.customerId) {
    args.push(params.customerId)
    scope = 'customer_id = $3::uuid AND '
  }
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT customer_id, dimension, SUM(quantity)::float AS quantity
     FROM splunk_byol_usage
     WHERE ${scope}period_start >= $1 AND period_start < $2
     GROUP BY customer_id, dimension
     ORDER BY customer_id, dimension`,
    ...args,
  )
  return rows.map((r) => ({
    customerId: r.customer_id,
    dimension: r.dimension,
    quantity: toNum(r.quantity),
  }))
}

/** Detailed usage rows over [from, to) for a customer (or all tenants). */
export async function listUsage(
  db: PlatformDatabaseClient,
  params: { customerId?: string; from: Date; to: Date },
): Promise<ByolUsageDto[]> {
  const args: unknown[] = [params.from, params.to]
  let scope = ''
  if (params.customerId) {
    args.push(params.customerId)
    scope = 'customer_id = $3::uuid AND '
  }
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT * FROM splunk_byol_usage
     WHERE ${scope}period_start >= $1 AND period_start < $2
     ORDER BY period_start DESC, infrastructure_id`,
    ...args,
  )
  return rows.map(mapUsage)
}
