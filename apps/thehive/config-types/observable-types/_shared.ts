// Shared helpers for the TheHive Observable Types config type (deploy + rollback + drift).
//
// Observable-type shapes follow the TheHive 5 API (InputObservableType /
// OutputObservableType at /api/v1/observable/type). TheHive 4 uses the same field
// names at /api/observable/type. Verify against a live TheHive (see README).
//
// IMPORTANT: TheHive 5 exposes NO update (PATCH) endpoint for observable types —
// only create / get / delete. So "upsert" here means create-if-missing; an
// existing type is left untouched (its `isAttachment` flag cannot be changed in
// place), and drift is reported rather than corrected. See deploy.ts / README.

/** A TheHive observable type as authored (InputObservableType) or returned (Output…). */
export interface ObservableType {
  // v5 returns `_id`; v4 returns `id`. Both are read via observableTypeId().
  _id?: string
  id?: string | number
  name?: string
  isAttachment?: boolean
  [key: string]: unknown
}

/** The stable id of a live observable type (v5 `_id`, else v4 `id`), or null. */
export function observableTypeId(t: ObservableType | null | undefined): string | null {
  if (!t) return null
  if (t._id != null && String(t._id).trim()) return String(t._id)
  if (t.id != null && String(t.id).trim()) return String(t.id)
  return null
}

/** Coerce a canvas value (checkbox / "true" / 1) to a boolean. */
export function parseBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = String(value ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

/** Find a live observable type by name (the stable identity). */
export function findObservableType(types: ObservableType[], name: string): ObservableType | null {
  const n = name.trim()
  if (!n) return null
  return types.find((t) => String(t.name ?? '').trim() === n) ?? null
}

/** Unwrap a list/query response into a flat array of observable types. */
export function observableTypesFromList(list: unknown): ObservableType[] {
  if (Array.isArray(list)) return list as ObservableType[]
  if (list && typeof list === 'object') {
    const rows = (list as Record<string, unknown>).data ?? (list as Record<string, unknown>).results
    if (Array.isArray(rows)) return rows as ObservableType[]
  }
  return []
}

/** Build the InputObservableType body TheHive expects from canvas fields. */
export function buildObservableTypeBody(fields: Record<string, unknown>): ObservableType {
  return {
    name: String(fields.name ?? '').trim(),
    isAttachment: parseBool(fields.isAttachment),
  }
}
