// Shared helpers for the runZero Asset Ownership Types config type (deploy + rollback + drift + validate).
//
// Asset ownership types are the picklist of "owner" categories (e.g. "Asset Owner", "Security
// Contact") an org can tag assets with (see /org/assets/{id}/owners). The console API models this
// as a BATCH resource — every write operation takes/returns an ARRAY, not a single object (verified
// against runZeroInc/runzero-api runzero-api.yml — AssetOwnershipType / AssetOwnershipTypePost):
//   List:    GET    /account/assets/ownership-types           → array of AssetOwnershipType
//   Create:  POST   /account/assets/ownership-types           body: array of AssetOwnershipTypePost
//                                                              → array of AssetOwnershipType (created)
//   Update:  PUT    /account/assets/ownership-types           body: array of AssetOwnershipType
//                                                              (full objects, id inside)
//                                                              → array of AssetOwnershipType (updated)
//   Delete:  DELETE /account/assets/ownership-types           body: array of ids
//                                                              → array of AssetOwnershipType (remaining)
//   (there is also a per-id PATCH/DELETE — /account/assets/ownership-types/{id} — for a single type,
//   not used here since the batch endpoints already give one deploy the ability to create+update
//   many types in as few round trips as possible)
//
// This shapes deploy/rollback differently from every other config type in this app: instead of one
// HTTP call per item, deploy sends AT MOST one batch POST (all new types) and one batch PUT (all
// changed existing types) per run, and rollback sends at most one batch DELETE and one batch PUT.
//
// FLAG (scope): asset ownership types are ACCOUNT-scoped resources — they live under /account, NOT
// /org. This config type requires the connection to carry an ACCOUNT-scoped runZero API key (the
// same flag as scan-templates); an Organization key gets 401/403 here (also gated behind a
// NotAllowedForLicenseError on some license tiers — surfaced as a clear deploy/health-check error).

/** One runZero AssetOwnershipType as returned by GET /account/assets/ownership-types. */
export interface RunzeroOwnershipType {
  id?: string
  name?: string
  reference?: number
  order?: number
  hidden?: boolean
  [key: string]: unknown
}

/** The AssetOwnershipTypePost request body for a batch POST create entry. */
export interface RunzeroOwnershipTypePost {
  name: string
  reference?: number
  order?: number
  hidden?: boolean
}

/** One entry in deploy's rollbackData.previous — what deploy did to a single ownership type. */
export interface OwnershipTypeRollbackEntry {
  name: string
  typeId: string | null
  existed: boolean
  prior: RunzeroOwnershipType | null
}

/** Trim any value to a string. */
export function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a canvas number field to an integer, or undefined when blank/invalid. */
export function intOrUndefined(value: unknown): number | undefined {
  if (value === '' || value === null || value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

/** Find a live ownership type by name (case-insensitive — the stable identity for upsert/drift). */
export function findOwnershipType(types: RunzeroOwnershipType[], name: string): RunzeroOwnershipType | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return types.find((t) => text(t.name).toLowerCase() === n) ?? null
}

/** Build the AssetOwnershipTypePost create body from canvas fields. */
export function buildOwnershipTypePost(fields: Record<string, unknown>): RunzeroOwnershipTypePost {
  const post: RunzeroOwnershipTypePost = { name: text(fields.name) }
  const order = intOrUndefined(fields.order)
  if (order !== undefined) post.order = order
  const reference = intOrUndefined(fields.reference)
  if (reference !== undefined) post.reference = reference
  if (fields.hidden !== undefined) post.hidden = fields.hidden === true
  return post
}

/** Build the full AssetOwnershipType update body (existing object + declared fields layered on top). */
export function buildOwnershipTypeUpdate(existing: RunzeroOwnershipType, fields: Record<string, unknown>): RunzeroOwnershipType {
  const order = intOrUndefined(fields.order)
  const reference = intOrUndefined(fields.reference)
  return {
    ...existing,
    name: text(fields.name) || existing.name,
    ...(order !== undefined ? { order } : {}),
    ...(reference !== undefined ? { reference } : {}),
    hidden: fields.hidden === true,
  }
}

/** True when the declared fields already match the live ownership type (skip a no-op update). */
export function ownershipTypeMatches(existing: RunzeroOwnershipType, fields: Record<string, unknown>): boolean {
  const order = intOrUndefined(fields.order)
  const reference = intOrUndefined(fields.reference)
  const hidden = fields.hidden === true
  if (order !== undefined && order !== existing.order) return false
  if (reference !== undefined && reference !== existing.reference) return false
  if (hidden !== (existing.hidden === true)) return false
  return true
}
