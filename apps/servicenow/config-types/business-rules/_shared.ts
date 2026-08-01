// Shared helpers for the ServiceNow Business Rules config type
// (validate + deploy + rollback + drift).
//
// Business rules live in the `sys_script` table. This app manages them as code
// over the Table API. Column names below are the sys_script data-dictionary
// columns the Table API reads/writes:
//   name             Name
//   collection       Table the rule runs on (e.g. "incident")
//   when             before | after | async | display
//   order            execution order (lower runs first; default 100)
//   active           enabled flag
//   advanced         when true, the `script` field runs (simple rules use the
//                    action_* + set-field options instead — this config type
//                    manages scripted rules, so it defaults advanced = true)
//   action_insert    run on record insert
//   action_update    run on record update
//   action_delete    run on record delete
//   action_query     run on table query (display rules)
//   filter_condition encoded "when to run" condition (e.g. active=true^priority=1)
//   script           server-side script body
//   description       free-text description
//
// A business rule name is NOT globally unique, so identity is the (name,
// collection) pair — the natural key an operator controls.

/** Valid sys_script `when` values. */
export const WHEN_VALUES = new Set(['before', 'after', 'async', 'display'])

/** The sys_script table name. */
export const SYS_SCRIPT_TABLE = 'sys_script'

/** The managed sys_script columns, in a stable order (used for drift + field lists). */
export const MANAGED_COLUMNS = [
  'name',
  'collection',
  'when',
  'order',
  'active',
  'advanced',
  'action_insert',
  'action_update',
  'action_delete',
  'action_query',
  'filter_condition',
  'script',
  'description',
] as const

/** One sys_script record as returned by the Table API (raw string values). */
export interface SysScriptRecord {
  sys_id?: string
  name?: string
  collection?: string
  when?: string
  order?: string | number
  active?: string | boolean
  advanced?: string | boolean
  action_insert?: string | boolean
  action_update?: string | boolean
  action_delete?: string | boolean
  action_query?: string | boolean
  filter_condition?: string
  script?: string
  description?: string
  [key: string]: unknown
}

/**
 * Normalize a ServiceNow boolean, which arrives as a real boolean or the strings
 * "true"/"false"/"1"/"0" (and from the canvas as a checkbox boolean).
 */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true' || s === '1') return true
  return false
}

/** Normalize an order value (string or number) to an integer, defaulting to 100. */
export function normalizeOrder(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) ? n : 100
}

/** The ServiceNow encoded query that identifies one rule by (name, collection). */
export function identityQuery(name: string, collection: string): string {
  return `name=${name.trim()}^collection=${collection.trim()}`
}

/** Find a live record by the (name, collection) identity within a result set. */
export function findRecord(records: SysScriptRecord[], name: string, collection: string): SysScriptRecord | null {
  const n = name.trim()
  const c = collection.trim()
  return (
    records.find((r) => String(r.name ?? '').trim() === n && String(r.collection ?? '').trim() === c) ?? null
  )
}

/**
 * Build the sys_script write body from canvas fields. Booleans are sent as real
 * JSON booleans (the Table API accepts them) and `order` as a number; everything
 * else is a trimmed string. Only the managed columns are ever written.
 */
export function buildRecordBody(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    name: String(fields.name ?? '').trim(),
    collection: String(fields.collection ?? '').trim(),
    when: String(fields.when ?? '').trim(),
    order: normalizeOrder(fields.order),
    active: normalizeBool(fields.active),
    advanced: normalizeBool(fields.advanced),
    action_insert: normalizeBool(fields.actionInsert),
    action_update: normalizeBool(fields.actionUpdate),
    action_delete: normalizeBool(fields.actionDelete),
    action_query: normalizeBool(fields.actionQuery),
    filter_condition: String(fields.filterCondition ?? '').trim(),
    script: String(fields.script ?? ''),
    description: String(fields.description ?? '').trim(),
  }
}

/** The subset of a live record we manage — used to snapshot for rollback + restore. */
export function managedSnapshot(record: SysScriptRecord): Record<string, unknown> {
  const snap: Record<string, unknown> = {}
  for (const col of MANAGED_COLUMNS) snap[col] = record[col] ?? ''
  return snap
}
