// Shared helpers for the TheHive Custom Fields config type (deploy + rollback + drift).
//
// Custom-field shapes follow the TheHive 5 API (InputCustomField / OutputCustomField
// at /api/v1/customField). TheHive 4 uses the same field names at /api/customField.
// Verify against a live TheHive (see README, v4 vs v5).

/**
 * Base data types a custom field can hold. Mirrors thehive4py's CustomFieldType
 * (string | integer | float | boolean | date | url).
 *
 * NOTE: TheHive 5 has NO dedicated "enumeration" type — an enumerated field is a
 * base type carrying an `options` allow-list. `url` is included because the
 * maintained client declares it; verify support on older builds.
 */
export const CUSTOM_FIELD_TYPES = ['string', 'integer', 'float', 'boolean', 'date', 'url'] as const
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

/** A TheHive custom field as authored (InputCustomField) or returned (Output…). */
export interface CustomField {
  // v5 returns `_id`; v4 returns `id`. Both are read via customFieldId().
  _id?: string
  id?: string | number
  name?: string
  displayName?: string
  group?: string
  description?: string
  type?: string
  options?: unknown[]
  mandatory?: boolean
  [key: string]: unknown
}

/** The update subset TheHive accepts (InputUpdateCustomField omits `name`). */
export interface CustomFieldUpdate {
  displayName?: string
  group?: string
  description?: string
  type?: string
  options?: unknown[]
  mandatory?: boolean
}

/** The stable id of a live custom field (v5 `_id`, else v4 `id`), or null. */
export function customFieldId(cf: CustomField | null | undefined): string | null {
  if (!cf) return null
  if (cf._id != null && String(cf._id).trim()) return String(cf._id)
  if (cf.id != null && String(cf.id).trim()) return String(cf.id)
  return null
}

/** Coerce a canvas value to a valid CustomFieldType; falls back to 'string'. */
export function normalizeType(value: unknown): CustomFieldType {
  const v = String(value ?? '').trim().toLowerCase()
  return (CUSTOM_FIELD_TYPES as readonly string[]).includes(v) ? (v as CustomFieldType) : 'string'
}

/** Coerce a canvas value (checkbox / "true" / 1) to a boolean. */
export function parseBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = String(value ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

/** Split an options textarea (newline and/or comma separated) into a deduped list. */
export function parseOptions(value: unknown): string[] {
  const raw = String(value ?? '')
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[\n,]/)) {
    const opt = part.trim()
    if (opt && !seen.has(opt)) {
      seen.add(opt)
      out.push(opt)
    }
  }
  return out
}

/** Find a live custom field by name (the stable identity). */
export function findCustomField(fields: CustomField[], name: string): CustomField | null {
  const n = name.trim()
  if (!n) return null
  return fields.find((f) => String(f.name ?? '').trim() === n) ?? null
}

/** Unwrap a list/query response into a flat array of custom fields. */
export function customFieldsFromList(list: unknown): CustomField[] {
  if (Array.isArray(list)) return list as CustomField[]
  if (list && typeof list === 'object') {
    const rows = (list as Record<string, unknown>).data ?? (list as Record<string, unknown>).results
    if (Array.isArray(rows)) return rows as CustomField[]
  }
  return []
}

/** Build the InputCustomField body from canvas fields (create path — includes name). */
export function buildCustomFieldBody(fields: Record<string, unknown>): CustomField {
  const name = String(fields.name ?? '').trim()
  const displayName = String(fields.displayName ?? '').trim()
  const group = String(fields.group ?? '').trim() || 'default'
  const description = String(fields.description ?? '').trim()
  const options = parseOptions(fields.options)
  const body: CustomField = {
    name,
    displayName: displayName || name,
    // group + description are required by InputCustomField, always send them.
    group,
    description,
    type: normalizeType(fields.type),
    mandatory: parseBool(fields.mandatory),
  }
  if (options.length > 0) body.options = options
  return body
}

/** The InputUpdateCustomField body (no `name` — TheHive rejects renaming here). */
export function buildCustomFieldUpdate(fields: Record<string, unknown>): CustomFieldUpdate {
  const body = buildCustomFieldBody(fields)
  return toUpdateBody(body)
}

/** Map a full custom field to the updatable subset (used by rollback restore). */
export function toUpdateBody(cf: CustomField): CustomFieldUpdate {
  const update: CustomFieldUpdate = {
    displayName: cf.displayName,
    group: cf.group,
    description: cf.description,
    type: cf.type,
    mandatory: cf.mandatory,
  }
  if (Array.isArray(cf.options)) update.options = cf.options
  return update
}
