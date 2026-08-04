// Shared helpers for the TheHive Organisations config type (deploy + rollback + drift).
//
// Organisation shapes follow the TheHive 5 API (InputOrganisation /
// InputUpdateOrganisation / OutputOrganisation at /api/v1/organisation). TheHive 4
// grew the same /api/v1/organisation create/update surface late in its life
// (confirmed via the TheHive 4 OpenAPI spec); only listing differs (see
// lib/thehiveApi.ts, listOrganisations). Verify against a live TheHive.
//
// IMPORTANT: TheHive has NO delete endpoint for organisations, on either
// version — organisations are multi-tenant containers for cases/alerts and are
// disabled via `locked`, never removed. So "upsert" here means create/update,
// and rollback of a CREATE locks the organisation rather than deleting it (the
// only safe, available undo). See deploy.ts / rollback.ts / README.

/** Sharing-rule values accepted for taskRule / observableRule. */
export const SHARING_RULES = ['manual', 'autoShare'] as const
export type SharingRule = (typeof SHARING_RULES)[number]

/** A TheHive organisation as authored (InputOrganisation) or returned (Output…). */
export interface Organisation {
  // v5 returns `_id`; v4 returns `id`. Both are read via organisationId().
  _id?: string
  id?: string | number
  name?: string
  description?: string
  taskRule?: string
  observableRule?: string
  locked?: boolean
  [key: string]: unknown
}

/** InputUpdateOrganisation — the mutable subset; `name` is omitted (see buildOrganisationUpdateBody). */
export interface OrganisationUpdate {
  description?: string
  taskRule?: string
  observableRule?: string
  locked?: boolean
}

/** The stable id of a live organisation (v5 `_id`, else v4 `id`), or null. */
export function organisationId(org: Organisation | null | undefined): string | null {
  if (!org) return null
  if (org._id != null && String(org._id).trim()) return String(org._id)
  if (org.id != null && String(org.id).trim()) return String(org.id)
  return null
}

/** Coerce a canvas value to a valid SharingRule; falls back to 'manual'. */
export function normalizeSharingRule(value: unknown): SharingRule {
  const v = String(value ?? '').trim()
  return (SHARING_RULES as readonly string[]).includes(v) ? (v as SharingRule) : 'manual'
}

/** Coerce a canvas value (checkbox / "true" / 1) to a boolean. */
export function parseBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = String(value ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

/** Find a live organisation by name (the stable identity). */
export function findOrganisation(orgs: Organisation[], name: string): Organisation | null {
  const n = name.trim()
  if (!n) return null
  return orgs.find((o) => String(o.name ?? '').trim() === n) ?? null
}

/** Unwrap a list/query response into a flat array of organisations. */
export function organisationsFromList(list: unknown): Organisation[] {
  if (Array.isArray(list)) return list as Organisation[]
  if (list && typeof list === 'object') {
    const rows = (list as Record<string, unknown>).data ?? (list as Record<string, unknown>).results
    if (Array.isArray(rows)) return rows as Organisation[]
  }
  return []
}

/** Build the InputOrganisation (create) body from canvas fields — name + description are required by the API. */
export function buildOrganisationCreateBody(fields: Record<string, unknown>): Organisation {
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    taskRule: normalizeSharingRule(fields.taskRule),
    observableRule: normalizeSharingRule(fields.observableRule),
    locked: parseBool(fields.locked),
  }
}

/**
 * Build the InputUpdateOrganisation (patch) body. `name` is deliberately omitted:
 * although the API accepts renaming an organisation, this config type upserts by
 * name (the stable identity used for lookup/drift), so a rename in the canvas is
 * indistinguishable from creating a new organisation — same convention as the
 * other config types in this app (users, custom fields).
 */
export function buildOrganisationUpdateBody(fields: Record<string, unknown>): OrganisationUpdate {
  return {
    description: String(fields.description ?? '').trim(),
    taskRule: normalizeSharingRule(fields.taskRule),
    observableRule: normalizeSharingRule(fields.observableRule),
    locked: parseBool(fields.locked),
  }
}

/** Map a live organisation to the updatable subset (used by rollback restore). */
export function toOrganisationUpdate(org: Organisation): OrganisationUpdate {
  return {
    description: String(org.description ?? ''),
    taskRule: normalizeSharingRule(org.taskRule),
    observableRule: normalizeSharingRule(org.observableRule),
    locked: parseBool(org.locked),
  }
}
