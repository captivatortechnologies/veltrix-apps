// Shared helpers for the runZero SSO Group Mappings config type (deploy + rollback + drift + validate).
//
// An SSO group mapping ties one identity-provider attribute/value pair (e.g. a SAML group claim) to
// a runZero Group, so members of that IdP group inherit the Group's role assignments on SSO login.
// The console API models it as (verified against runZeroInc/runzero-api runzero-api.yml —
// GroupMapping):
//   List:    GET    /account/sso/groups                       → array of GroupMapping
//   Create:  POST   /account/sso/groups                        body GroupMapping → GroupMapping
//   Update:  PUT    /account/sso/groups                        body GroupMapping (full object, id
//                                                               inside) → GroupMapping
//   Get:     GET    /account/sso/groups/{group_mapping_id}
//   Delete:  DELETE /account/sso/groups/{group_mapping_id}
//
// FLAG (spec quirk): the POST/PUT request body schema is the SAME `GroupMapping` schema used for the
// GET response, which lists `id` as required — but an id cannot be known before create. In practice
// this config type omits `id` on create and only includes it on update; this is not independently
// re-verified against a live account beyond the shared-schema observation itself.
//
// IDENTITY: there is no single-field identity — a mapping is uniquely identified by the pair
// (sso_attribute, sso_value). Matching is exact (case-sensitive, trimmed) since these are opaque
// values supplied by the identity provider (e.g. a SAML group claim or LDAP DN), where case can be
// significant.
//
// FLAG (scope): SSO group mappings are ACCOUNT-scoped resources — they live under /account, NOT
// /org. This config type requires the connection to carry an ACCOUNT-scoped runZero API key (the
// same flag as scan-templates); an Organization key gets 401/403 here.

/** One runZero GroupMapping as returned by GET /account/sso/groups. */
export interface RunzeroGroupMapping {
  id?: string
  group_id?: string
  group_name?: string
  sso_attribute?: string
  sso_value?: string
  description?: string
  [key: string]: unknown
}

/** A runZero Group as far as SSO mappings need it — resolve a group name to its id. */
export interface RunzeroGroupLite {
  id?: string
  name?: string
  [key: string]: unknown
}

/** One entry in deploy's rollbackData.previous — what deploy did to a single mapping. */
export interface SsoGroupMappingRollbackEntry {
  ssoAttribute: string
  ssoValue: string
  mappingId: string | null
  existed: boolean
  prior: RunzeroGroupMapping | null
}

/** Trim any value to a string. */
export function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** Resolve a group reference (name or UUID) to a group id using the live group list; falls back to the raw ref. */
export function resolveGroupId(groups: RunzeroGroupLite[], groupRef: unknown): string {
  const ref = text(groupRef)
  if (!ref) return ref
  const byName = groups.find((g) => text(g.name).toLowerCase() === ref.toLowerCase())
  return byName?.id ?? ref
}

/** Find a live mapping by its (sso_attribute, sso_value) composite identity — exact, case-sensitive. */
export function findMapping(mappings: RunzeroGroupMapping[], ssoAttribute: string, ssoValue: string): RunzeroGroupMapping | null {
  if (!ssoAttribute || !ssoValue) return null
  return mappings.find((m) => m.sso_attribute === ssoAttribute && m.sso_value === ssoValue) ?? null
}

/** Build the GroupMapping create body (no id — see the spec-quirk note above). */
export function buildMapping(fields: Record<string, unknown>, resolvedGroupId: string): Omit<RunzeroGroupMapping, 'id'> {
  return {
    group_id: resolvedGroupId,
    sso_attribute: text(fields.ssoAttribute),
    sso_value: text(fields.ssoValue),
    description: text(fields.description),
  }
}

/** Build the GroupMapping update body (full object, id embedded). */
export function buildMappingUpdate(id: string, fields: Record<string, unknown>, resolvedGroupId: string): RunzeroGroupMapping {
  return { id, ...buildMapping(fields, resolvedGroupId) }
}

/** Build a GroupMapping body that restores a prior recorded mapping (rollback). */
export function buildMappingFromPrior(id: string, prior: RunzeroGroupMapping): RunzeroGroupMapping {
  return {
    id,
    group_id: text(prior.group_id),
    sso_attribute: text(prior.sso_attribute),
    sso_value: text(prior.sso_value),
    description: text(prior.description),
  }
}
