// Shared helpers for the Graylog Index Sets config type (validate + deploy +
// rollback + drift). Shapes follow the Graylog REST API
// (/api/system/indices/index_sets):
//   • POST/PUT body  = IndexSetSummary (many required fields)
//   • GET  response  = IndexSetResponse { total, index_sets: [IndexSetSummary], stats }
// Verified against graylog2-server rest/resources/system/indexer/
//   IndexSetsResource.java + responses/IndexSetSummary.java (@ 6.1) and the
//   rotation/retention strategy config classes.
//
// Required-on-create fields Graylog demands beyond the four the operator supplies
// (title, index_prefix, rotation, retention) are filled with sensible defaults
// here: shards, replicas, index_analyzer, index_optimization_*, writable, etc.
//
// The rotation/retention `*_strategy_class` values AND the `type` discriminator
// inside each strategy config are the SAME fully-qualified class name
// (@JsonTypeInfo Id.CLASS, property "type").

import { asString, toInt } from '../../lib/coerce'

/** Graylog index prefix pattern (IndexPrefixField.INDEX_PREFIX_REGEX @ graylog2-server). */
export const INDEX_PREFIX_REGEX = /^[a-z0-9][a-z0-9_+-]*$/

/** ISO-8601 period (e.g. P1D, PT6H) accepted by the time-based rotation strategy. */
export const ISO8601_PERIOD_REGEX = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/

export const ROTATION_STRATEGIES = {
  msgcount: 'org.graylog2.indexer.rotation.strategies.MessageCountRotationStrategyConfig',
  size: 'org.graylog2.indexer.rotation.strategies.SizeBasedRotationStrategyConfig',
  time: 'org.graylog2.indexer.rotation.strategies.TimeBasedRotationStrategyConfig',
} as const
export type RotationKind = keyof typeof ROTATION_STRATEGIES

export const RETENTION_STRATEGIES = {
  delete: 'org.graylog2.indexer.retention.strategies.DeletionRetentionStrategyConfig',
  close: 'org.graylog2.indexer.retention.strategies.ClosingRetentionStrategyConfig',
  none: 'org.graylog2.indexer.retention.strategies.NoopRetentionStrategyConfig',
} as const
export type RetentionKind = keyof typeof RETENTION_STRATEGIES

/** Boilerplate required fields Graylog demands on create — sensible defaults. */
export const INDEX_SET_DEFAULTS = {
  shards: 4,
  replicas: 0,
  index_analyzer: 'standard',
  index_optimization_max_num_segments: 1,
  // Graylog serializes its Duration as milliseconds; 5s is the product default.
  field_type_refresh_interval: 5000,
}

export interface StrategyConfig {
  type: string
  [key: string]: unknown
}

/** An index set as returned by GET /api/system/indices/index_sets. */
export interface GraylogIndexSet {
  id?: string
  title?: string
  description?: string
  index_prefix?: string
  shards?: number
  replicas?: number
  rotation_strategy_class?: string
  rotation_strategy?: StrategyConfig
  retention_strategy_class?: string
  retention_strategy?: StrategyConfig
  writable?: boolean
  default?: boolean
  [key: string]: unknown
}

/** GET /api/system/indices/index_sets envelope. */
export interface IndexSetResponse {
  total?: number
  index_sets?: GraylogIndexSet[]
}

/** Unwrap the list response into a flat array of index sets. */
export function indexSetsFromList(list: unknown): GraylogIndexSet[] {
  if (Array.isArray(list)) return list as GraylogIndexSet[]
  const sets = (list as IndexSetResponse | null)?.index_sets
  return Array.isArray(sets) ? sets : []
}

/** Find a live index set by title (the stable identity used for upsert + drift). */
export function findIndexSet(sets: GraylogIndexSet[], title: string): GraylogIndexSet | null {
  const t = asString(title)
  if (!t) return null
  return sets.find((s) => asString(s.title) === t) ?? null
}

/** Normalize a rotation kind to one of the known keys (defaults to msgcount). */
export function normalizeRotationKind(value: unknown): RotationKind {
  const s = asString(value).toLowerCase()
  return s in ROTATION_STRATEGIES ? (s as RotationKind) : 'msgcount'
}

/** Normalize a retention kind to one of the known keys (defaults to delete). */
export function normalizeRetentionKind(value: unknown): RetentionKind {
  const s = asString(value).toLowerCase()
  return s in RETENTION_STRATEGIES ? (s as RetentionKind) : 'delete'
}

/** Build the rotation strategy config (class + typed params) for a kind. */
export function buildRotationStrategy(kind: RotationKind, rawValue: unknown): { clazz: string; config: StrategyConfig } {
  const clazz = ROTATION_STRATEGIES[kind]
  if (kind === 'time') {
    return { clazz, config: { type: clazz, rotation_period: asString(rawValue) || 'P1D' } }
  }
  if (kind === 'size') {
    return { clazz, config: { type: clazz, max_size: toInt(rawValue, 1073741824) } }
  }
  return { clazz, config: { type: clazz, max_docs_per_index: toInt(rawValue, 20000000) } }
}

/** Build the retention strategy config (class + typed params) for a kind. */
export function buildRetentionStrategy(kind: RetentionKind, rawValue: unknown): { clazz: string; config: StrategyConfig } {
  const clazz = RETENTION_STRATEGIES[kind]
  // All three strategies carry max_number_of_indices (noop ignores it at runtime).
  return { clazz, config: { type: clazz, max_number_of_indices: toInt(rawValue, 20) } }
}

export interface BuiltIndexSetBody {
  body?: Record<string, unknown>
  error?: string
}

/**
 * Build the IndexSetSummary create/update body from canvas fields, filling the
 * required boilerplate with defaults. `use_legacy_rotation: true` selects the
 * classic rotation/retention model (rather than data tiering) so the strategies
 * we send are authoritative.
 */
export function buildIndexSetBody(fields: Record<string, unknown>): BuiltIndexSetBody {
  const rotation = buildRotationStrategy(normalizeRotationKind(fields.rotation_strategy), fields.rotation_value)
  const retention = buildRetentionStrategy(normalizeRetentionKind(fields.retention_strategy), fields.retention_max_indices)

  const body: Record<string, unknown> = {
    title: asString(fields.title),
    description: asString(fields.description),
    index_prefix: asString(fields.index_prefix),
    shards: toInt(fields.shards, INDEX_SET_DEFAULTS.shards),
    replicas: toInt(fields.replicas, INDEX_SET_DEFAULTS.replicas),
    index_analyzer: INDEX_SET_DEFAULTS.index_analyzer,
    index_optimization_max_num_segments: INDEX_SET_DEFAULTS.index_optimization_max_num_segments,
    index_optimization_disabled: false,
    field_type_refresh_interval: INDEX_SET_DEFAULTS.field_type_refresh_interval,
    writable: true,
    default: false,
    can_be_default: true,
    use_legacy_rotation: true,
    rotation_strategy_class: rotation.clazz,
    rotation_strategy: rotation.config,
    retention_strategy_class: retention.clazz,
    retention_strategy: retention.config,
  }
  return { body }
}

/** Fields Graylog computes/returns on read that must not be sent back on a PUT restore. */
const READ_ONLY_KEYS = ['data_tiering_status', 'stats']

/** Build a restore body from a live index set (rollback) — the summary is a valid PUT body. */
export function bodyFromLiveIndexSet(set: GraylogIndexSet): Record<string, unknown> {
  const body: Record<string, unknown> = { ...set }
  for (const key of READ_ONLY_KEYS) delete body[key]
  return body
}
