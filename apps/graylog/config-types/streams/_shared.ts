// Shared helpers for the Graylog Streams config type (validate + deploy + rollback
// + drift). Stream + rule shapes follow the Graylog REST API (/api/streams and
// /api/streams/{id}); verify against a live Graylog instance.

import { getJson } from '../../lib/graylogApi'

/** Valid stream matching types (a message must match ALL / ANY rules). */
export const MATCHING_TYPES = new Set(['AND', 'OR'])

/**
 * Graylog stream-rule `type` integers (org.graylog2.plugin.streams.StreamRuleType).
 * Source: graylog2-server StreamRuleType.java.
 */
export const STREAM_RULE_TYPES: Record<number, string> = {
  1: 'match exactly',
  2: 'match regular expression',
  3: 'greater than',
  4: 'smaller than',
  5: 'field presence',
  6: 'contain',
  7: 'always match',
  8: 'match input',
}

/** Rule types that do not need a `value` (presence / always-match). */
export const VALUELESS_RULE_TYPES = new Set([5, 7])

/** One stream rule as sent to / returned by Graylog. */
export interface GraylogStreamRule {
  field?: string
  type?: number
  value?: string
  inverted?: boolean
  description?: string
}

/** One stream as returned by GET /api/streams. */
export interface GraylogStream {
  id?: string
  title?: string
  description?: string
  rules?: GraylogStreamRule[]
  matching_type?: string
  index_set_id?: string
  remove_matches_from_default_stream?: boolean
  disabled?: boolean
  [key: string]: unknown
}

/** GET /api/streams envelope: `{ total, streams: [...] }`. */
export interface StreamListResponse {
  total?: number
  streams?: GraylogStream[]
}

/** An index set as returned by GET /api/system/indices/index_sets. */
interface IndexSet {
  id?: string
  title?: string
  default?: boolean
  writable?: boolean
}
interface IndexSetListResponse {
  total?: number
  index_sets?: IndexSet[]
}

/** Normalize a matching type to Graylog's uppercase AND/OR (defaults to AND). */
export function normalizeMatchingType(value: unknown): string {
  const s = String(value ?? '').trim().toUpperCase()
  return MATCHING_TYPES.has(s) ? s : 'AND'
}

/** Coerce a checkbox/boolean-ish value to a boolean. */
export function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'on'
}

export interface ParsedRules {
  rules: GraylogStreamRule[]
  error?: string
}

/**
 * Parse the canvas `rules` field. Accepts an already-parsed array (defensive) or a
 * JSON string of an array of `{ field, type, value, inverted }`. An empty/blank
 * value is a valid empty rule set. Returns a structured error rather than throwing
 * so validate() can surface it cleanly.
 */
export function parseRules(value: unknown): ParsedRules {
  if (value == null || value === '') return { rules: [] }
  let raw: unknown = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { rules: [] }
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return { rules: [], error: `rules is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
  }
  if (!Array.isArray(raw)) return { rules: [], error: 'rules must be a JSON array of rule objects' }
  const rules: GraylogStreamRule[] = raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>
    const rule: GraylogStreamRule = {
      field: o.field == null ? '' : String(o.field),
      type: typeof o.type === 'number' ? o.type : Number(o.type),
      inverted: toBool(o.inverted),
    }
    if (o.value !== undefined && o.value !== null) rule.value = String(o.value)
    if (o.description != null) rule.description = String(o.description)
    return rule
  })
  return { rules }
}

/** Unwrap GET /api/streams into a flat array of streams. */
export function streamsFromList(list: unknown): GraylogStream[] {
  if (Array.isArray(list)) return list as GraylogStream[]
  const streams = (list as StreamListResponse | null)?.streams
  return Array.isArray(streams) ? streams : []
}

/** Find a live stream by title (the stable identity used for upsert + drift). */
export function findStream(streams: GraylogStream[], title: string): GraylogStream | null {
  const t = title.trim()
  if (!t) return null
  return streams.find((s) => String(s.title ?? '').trim() === t) ?? null
}

/**
 * Build the Graylog stream body from canvas fields. `index_set_id` is required by
 * POST /api/streams — callers resolve it (item field or the default index set)
 * before sending, so it is threaded in here.
 */
export function buildStreamBody(fields: Record<string, unknown>, indexSetId: string): GraylogStream {
  const { rules } = parseRules(fields.rules)
  return {
    title: String(fields.title ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    matching_type: normalizeMatchingType(fields.matching_type),
    remove_matches_from_default_stream: toBool(fields.remove_matches_from_default_stream),
    index_set_id: indexSetId,
    rules,
  }
}

/**
 * Resolve the index set id for a stream: the item's own value when set, otherwise
 * the instance's DEFAULT index set (GET /api/system/indices/index_sets). Graylog
 * rejects a stream create without a valid index_set_id, so this makes `index_set_id`
 * optional in the canvas while still producing a valid body. Best-effort — returns
 * an empty string if none can be resolved (deploy surfaces the resulting API error).
 */
export async function resolveIndexSetId(
  base: string,
  headers: Record<string, string>,
  provided: unknown,
): Promise<string> {
  const explicit = String(provided ?? '').trim()
  if (explicit) return explicit
  try {
    const res = await getJson<IndexSetListResponse>(`${base}/api/system/indices/index_sets`, headers)
    const sets = res.index_sets ?? []
    const preferred = sets.find((s) => s.default) ?? sets.find((s) => s.writable) ?? sets[0]
    return String(preferred?.id ?? '').trim()
  } catch {
    return ''
  }
}
