// Shared helpers for the Sumo Logic Custom Fields config type
// (deploy + rollback + drift + validate).
//
// A custom field is a flat record { fieldId?, fieldName, dataType?, state? }. The
// list endpoint returns them inside a { data: [...] } envelope. A field's on/off
// status is NOT a body property — it is toggled with dedicated endpoints:
//   enable:  PUT    v1/fields/{id}/enable
//   disable: DELETE v1/fields/{id}/disable
//   create:  POST   v1/fields   with { fieldName }  (created Enabled)
//   delete:  DELETE v1/fields/{id}
//   API: https://www.sumologic.com/help/docs/api/field-management/
//   Endpoints/shapes verified against the SumoLogic terraform provider model
//   (sumologic/sumologic_field.go): fieldName, fieldId, dataType, state.

/** One Sumo Logic custom field. */
export interface CustomField {
  /** Sumo-assigned id (path parameter for get/delete/enable/disable). */
  fieldId?: string
  /** Field name — the stable identity used to upsert. */
  fieldName: string
  /** System-assigned data type (String, Long, …) — read-only, not set on create. */
  dataType?: string
  /** 'Enabled' or 'Disabled'. */
  state?: string
  [key: string]: unknown
}

/** The { data: [...] } envelope returned by GET /fields. */
export interface CustomFieldList {
  data?: CustomField[]
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * The canvas `enabled` checkbox may arrive as a boolean, an 'enabled'/'disabled'
 * string, or 1/0 — normalize to a boolean. Defaults to true (a new field is
 * created Enabled) when unset.
 */
export function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = s(value).toLowerCase()
  if (v === 'disabled' || v === 'false' || v === '0' || v === 'no') return false
  return true
}

/** True when a live field's `state` is Enabled. */
export function isFieldEnabled(field: CustomField | null | undefined): boolean {
  return s(field?.state).toLowerCase() === 'enabled'
}

/** Unwrap the { data: [...] } list envelope into a flat array of fields. */
export function fieldsFromList(list: unknown): CustomField[] {
  if (Array.isArray(list)) return list as CustomField[]
  const data = (list as CustomFieldList | null | undefined)?.data
  return Array.isArray(data) ? data : []
}

/** Find a live field by name (case-insensitive, trimmed) — the field identity. */
export function findField(fields: CustomField[], fieldName: string): CustomField | null {
  const n = fieldName.trim().toLowerCase()
  if (!n) return null
  return fields.find((f) => s(f.fieldName).toLowerCase() === n) ?? null
}

/** Create-request body — Sumo Logic only accepts the field name on create. */
export function buildFieldCreateBody(fields: Record<string, unknown>): { fieldName: string } {
  return { fieldName: s(fields.fieldName) }
}
