// Shared helpers for the Sumo Logic Partitions config type
// (deploy + rollback + drift + validate).
//
// A partition (index) is a flat record { id?, name, routingExpression,
// analyticsTier?, retentionPeriod?, isCompliant?, isActive?, ... }. The list
// endpoint returns them inside a { data: [...], next } envelope and pages via a
// `?token=` query parameter.
//   API: https://www.sumologic.com/help/docs/api/partition-management/
//   Endpoints/shapes verified against the SumoLogic terraform provider model
//   (sumologic/sumologic_partition.go): create POST v1/partitions,
//   update PUT v1/partitions/{id}, decommission POST v1/partitions/{id}/decommission
//   (partitions cannot be deleted — verified), list GET v1/partitions → { data, next }.

/** One Sumo Logic partition (index). */
export interface Partition {
  id?: string
  /** Partition name — the stable identity used to upsert. Immutable in Sumo Logic. */
  name: string
  /** The query defining which messages the partition holds (the pre-`|` scope). */
  routingExpression: string
  /** Data tier the partition resides in (immutable after create). */
  analyticsTier?: string | null
  /** Days to retain data, or -1 for the account default. */
  retentionPeriod?: number
  /** Whether the partition is a compliant (immutable-retention) partition. */
  isCompliant?: boolean
  /** False once decommissioned — decommissioned partitions cannot be updated. */
  isActive?: boolean
  totalBytes?: number
  dataForwardingId?: string | null
  indexType?: string
  isIncludedInDefaultSearch?: boolean
  [key: string]: unknown
}

/** The { data: [...], next } envelope returned by GET /partitions. */
export interface PartitionList {
  data?: Partition[]
  next?: string | null
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a checkbox/string value to a boolean. Defaults to false when unset. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = s(value).toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'enabled'
}

/**
 * Parse a retention value into whole days. Blank/non-numeric → undefined (the
 * caller omits it and Sumo applies the account default). -1 is preserved as the
 * explicit "account default" sentinel.
 */
export function toRetentionDays(value: unknown): number | undefined {
  if (value === '' || value === null || value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return Math.trunc(n)
}

/** Unwrap the { data: [...] } list envelope into a flat array of partitions. */
export function partitionsFromList(list: unknown): Partition[] {
  if (Array.isArray(list)) return list as Partition[]
  const data = (list as PartitionList | null | undefined)?.data
  return Array.isArray(data) ? data : []
}

/** Find a live partition by name (case-insensitive, trimmed) — the partition identity. */
export function findPartition(partitions: Partition[], name: string): Partition | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return partitions.find((p) => s(p.name).toLowerCase() === n) ?? null
}

/**
 * Create-request body from canvas fields. `name` and `analyticsTier` are only
 * meaningful at create time (both are immutable afterwards).
 */
export function buildPartitionCreateBody(fields: Record<string, unknown>): Partition {
  const body: Partition = {
    name: s(fields.name),
    routingExpression: s(fields.routingExpression),
  }
  const tier = s(fields.analyticsTier)
  if (tier) body.analyticsTier = tier
  const retention = toRetentionDays(fields.retentionPeriod)
  if (retention !== undefined) body.retentionPeriod = retention
  if (normalizeBool(fields.isCompliant)) body.isCompliant = true
  return body
}

/**
 * Update-request body from canvas fields. Only the mutable fields are sent —
 * name and analyticsTier are rejected on update. `isCompliant` is only raised
 * (false → true); Sumo Logic forbids un-complying a partition, so a desired
 * `false` is omitted (the partition keeps its current compliance; surfaced as
 * drift rather than a hard error).
 */
export function buildPartitionUpdateBody(
  fields: Record<string, unknown>,
  existing?: Partition | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = { routingExpression: s(fields.routingExpression) }
  const retention = toRetentionDays(fields.retentionPeriod)
  if (retention !== undefined) body.retentionPeriod = retention
  if (normalizeBool(fields.isCompliant) && !existing?.isCompliant) body.isCompliant = true
  return body
}

/** Restore-request body for rollback, rebuilt from a prior partition snapshot. */
export function buildPartitionRestoreBody(prior: Partition): Record<string, unknown> {
  const body: Record<string, unknown> = { routingExpression: s(prior.routingExpression) }
  if (typeof prior.retentionPeriod === 'number') body.retentionPeriod = prior.retentionPeriod
  if (prior.isCompliant) body.isCompliant = true
  return body
}
