// Shared helpers for the Keycloak Authorization (client resource-server) config
// type (deploy + rollback + drift). Covers FOUR distinct Admin REST API sub-
// resources under a single client's authz resource server, selected by the
// item's `kind`:
//   resource      ResourceRepresentation      {base}/resource
//   scope         ScopeRepresentation         {base}/scope
//   permission    (Resource|Scope)PermissionRepresentation
//                                              {base}/permission/{resource|scope}
//   role-policy   RolePolicyRepresentation     {base}/policy/role
// where {base} = /clients/{clientUuid}/authz/resource-server. The identity is
// the COMPOSITE (clientId, kind, name) — the same name could plausibly appear
// under more than one kind on the same client (e.g. a resource and a scope both
// named "reports"), so validate.ts dedups on the full triple, not name alone.
//
// PRECONDITION (checked in deploy.ts / skipped-in drift.ts, not here): the
// target client must already have authorization services enabled
// (GET {base} returns non-2xx otherwise) — see deploy.ts for the fail-fast
// check, mirroring cisco-meraki's appliance-vlans "VLANs must be enabled on the
// network" precondition pattern.
//
// VERIFIED directly against the Keycloak server source (keycloak/keycloak on
// GitHub, services/.../admin/):
//   - ResourceSetService.java: POST {base}/resource creates a resource; the list
//     endpoint GET {base}/resource accepts `name`, `exactName` (plus `_id`, `uri`,
//     `owner`, `type`, `scope`, `matchingUri`, `deep`, `first`, `max`) query params.
//   - ResourceSetService.java (scope sub-resource): POST {base}/scope creates a
//     scope; GET {base}/scope accepts `name`.
//   - PolicyService.java: POST {base}/policy/role creates a role-based policy;
//     GET {base}/policy accepts `name` (and, per the resource's own type
//     registry, a `type` filter — used here as `type=role`).
//   - PermissionService.java: POST {base}/permission/resource and
//     POST {base}/permission/scope create the two permission types; GET
//     {base}/permission accepts `name` and returns permissions of EITHER type.
//
// NOT independently verified to the same certainty (flagged here AND at each
// call site AND in the app README's Coverage section — verify against a live
// Keycloak before relying on this in production):
//   - PUT/DELETE {base}/permission/{id} and PUT/DELETE {base}/policy/{id}
//     WITHOUT a type segment, once the id is known. This mirrors the general
//     Keycloak admin-console UI behavior (edit/delete operate purely on the
//     {id} path once a policy/permission exists) and the shape of the
//     `keycloak_*_permission`/`keycloak_*_policy` Terraform resources, but was
//     not traced directly through PermissionService.java/PolicyService.java's
//     update/delete method signatures with the same rigor as the create paths.
//   - The exact filtering semantics of GET {base}/policy?name=&type=role (that
//     `type=role` reliably scopes the list to role policies only) — inferred
//     from PolicyProviderFactory's registered `role` type id, not traced
//     through PolicyService's query-parameter handling line by line.
// Every list-by-name call below still re-checks the result client-side
// (findByExactName) rather than trusting a server-side filter is exact, per
// this app's existing convention (see clients/groups/protocol-mappers).

import {
  parseJsonField,
  readBool,
  readKeyValueMap,
  readOptionalString,
  readString,
  readStringArray,
} from '../../lib/fields'
import { parseJson } from '../../lib/keycloakApi'
import type { KeycloakAdminClient } from '../../lib/keycloakApi'
import { resolveClientByClientId } from '../../lib/clients'

export const KINDS = new Set(['resource', 'scope', 'permission', 'role-policy'])
export type AuthorizationKind = 'resource' | 'scope' | 'permission' | 'role-policy'

export const PERMISSION_TYPES = new Set(['resource', 'scope'])
export const DECISION_STRATEGIES = new Set(['UNANIMOUS', 'AFFIRMATIVE', 'CONSENSUS'])
export const POLICY_LOGIC = new Set(['POSITIVE', 'NEGATIVE'])

/** The authz resource-server base path under a resolved client UUID. */
export function resourceServerBase(clientUuid: string): string {
  return `/clients/${encodeURIComponent(clientUuid)}/authz/resource-server`
}

// --- Representations ----------------------------------------------------------

/** A {id, name} reference, the shape scope/resource/policy refs resolve to. */
export interface KeycloakNamedRef {
  id?: string
  name?: string
}

/** A resource as returned by GET {base}/resource/{id} (or the list endpoint). */
export interface KeycloakResourceRep {
  id?: string
  name?: string
  displayName?: string
  uris?: string[]
  scopes?: KeycloakNamedRef[]
  type?: string
  owner?: unknown
  ownerManagedAccess?: boolean
  attributes?: Record<string, string[]>
  [key: string]: unknown
}

/** A scope as returned by GET {base}/scope/{id} (or the list endpoint). */
export interface KeycloakAuthzScopeRep {
  id?: string
  name?: string
  displayName?: string
  iconUri?: string
  [key: string]: unknown
}

/** A role reference on a role-based policy: RolePolicyRepresentation.RoleDefinition. */
export interface KeycloakPolicyRoleRef {
  id?: string
  required?: boolean
}

/** A resource- or scope-based permission (AbstractPolicyRepresentation + subtype fields). */
export interface KeycloakPermissionRep {
  id?: string
  name?: string
  description?: string
  type?: string
  decisionStrategy?: string
  logic?: string
  /** Ids of the policies combined to decide this permission. */
  policies?: string[]
  /** Resource ids this permission applies to (resource-based permissions only). */
  resources?: string[]
  /** Match every resource of this type instead of naming resources explicitly. */
  resourceType?: string
  /** Scope ids this permission applies to. */
  scopes?: string[]
  [key: string]: unknown
}

/** A role-based policy (AbstractPolicyRepresentation + RolePolicyRepresentation.roles). */
export interface KeycloakRolePolicyRep {
  id?: string
  name?: string
  description?: string
  type?: string
  decisionStrategy?: string
  logic?: string
  roles?: KeycloakPolicyRoleRef[]
  [key: string]: unknown
}

/** Any of the four representations, once erased to the fields rollback needs. */
export type KeycloakAuthorizationRep = Record<string, unknown>

/** Find an item by an exact (trimmed) name match — never trust a list filter is exact. */
export function findByExactName<T extends { name?: string }>(list: T[], name: string): T | null {
  const target = name.trim()
  if (!target) return null
  return list.find((item) => String(item.name ?? '').trim() === target) ?? null
}

// --- Resource attributes: Map<String, List<String>> ----------------------------
// Same fact as groups/_shared.ts's attribute helpers (Keycloak attributes are
// always a Map<String,List<String>>), duplicated locally per this app's
// convention that config types do not import each other's _shared.ts.

/** Wrap a flat keyvalue map into Keycloak's Map<String, List<String>> shape. */
export function attributesFromKeyValue(map: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(map)) out[key] = [value]
  return out
}

/** Flatten Keycloak's Map<String, List<String>> attributes to a first-value map. */
export function singleValuedAttributes(attrs: Record<string, string[]> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!attrs) return out
  for (const [key, list] of Object.entries(attrs)) {
    if (Array.isArray(list) && list.length > 0) out[key] = String(list[0])
  }
  return out
}

// --- Role-ref name parsing (pure) ----------------------------------------------
// A role-policy's `roles` entries name a role as either a bare realm-role name
// ("admin") or "clientId/roleName" ("my-client/some-role") for a client role —
// the same flat "clientId/roleName" string convention as the official
// `keycloak_default_roles` Terraform resource's `default_roles` list
// (registry.terraform.io/providers/keycloak/keycloak/latest/docs/resources/default_roles),
// which is itself SplitN(name, "/", 2). This app's own default-roles config
// type covers the same client-vs-realm-role distinction but authors it as a
// nested { clientId: [roleNames] } JSON map instead — a different shape for a
// different canvas field, not reused here.

export type ParsedRoleRefName = { clientId: string; roleName: string } | { roleName: string }

/** Split "clientId/roleName" on the FIRST slash; anything else is a bare realm-role name. */
export function parseRoleRefName(name: string): ParsedRoleRefName {
  const idx = name.indexOf('/')
  if (idx <= 0 || idx === name.length - 1) return { roleName: name }
  return { clientId: name.slice(0, idx), roleName: name.slice(idx + 1) }
}

export interface RoleEntryInput {
  name: string
  required: boolean
}

/**
 * Parse the role-policy `roles` JSON-array textarea field: a non-empty array
 * where every entry has a non-empty string `name` and a boolean `required`,
 * e.g. [{"name":"admin","required":true},{"name":"my-client/some-role","required":false}].
 * Shared by validate.ts (shape-check only) and deploy.ts/driftDetect.ts (resolve
 * each name to a role id via resolveRoleRef).
 */
export function parseRoleEntriesField(raw: unknown): { entries: RoleEntryInput[] | null; error: string | null } {
  const parsed = parseJsonField(raw)
  if (!parsed.ok) return { entries: null, error: 'Roles is not valid JSON.' }
  if (parsed.value === undefined) return { entries: null, error: 'Roles is required for a role-based policy.' }
  if (!Array.isArray(parsed.value) || parsed.value.length === 0) {
    return { entries: null, error: 'Roles must be a non-empty JSON array.' }
  }

  const entries: RoleEntryInput[] = []
  for (let i = 0; i < parsed.value.length; i++) {
    const entry = parsed.value[i]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { entries: null, error: `roles[${i}] must be a JSON object.` }
    }
    const rec = entry as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    if (!name) return { entries: null, error: `roles[${i}] is missing a non-empty "name" string.` }
    if (typeof rec.required !== 'boolean') {
      return { entries: null, error: `roles[${i}] is missing a boolean "required" field.` }
    }
    entries.push({ name, required: rec.required })
  }
  return { entries, error: null }
}

/** Two {id, required} role-ref sets are equal (order-insensitive, matched by id). */
export function roleRefSetsEqual(a: KeycloakPolicyRoleRef[], b: KeycloakPolicyRoleRef[]): boolean {
  if (a.length !== b.length) return false
  const bByid = new Map(b.map((ref) => [String(ref.id ?? ''), Boolean(ref.required)]))
  return a.every((ref) => {
    const id = String(ref.id ?? '')
    return id.length > 0 && bByid.has(id) && bByid.get(id) === Boolean(ref.required)
  })
}

// --- Network: precondition ------------------------------------------------------

/** True when the client's authorization services (resource server) are enabled. */
export async function isAuthorizationEnabled(admin: KeycloakAdminClient, clientUuid: string): Promise<boolean> {
  const res = await admin.get(resourceServerBase(clientUuid))
  return res.ok
}

// --- Network: identity lookups (list + client-side exact match) ---------------

export async function fetchResourceByName(
  admin: KeycloakAdminClient,
  clientUuid: string,
  name: string,
): Promise<KeycloakResourceRep | null> {
  const res = await admin.get(`${resourceServerBase(clientUuid)}/resource?name=${encodeURIComponent(name)}&exactName=true`)
  if (!res.ok) return null
  const list = parseJson<KeycloakResourceRep[]>(res.body) ?? []
  return findByExactName(list, name)
}

export async function fetchScopeByName(
  admin: KeycloakAdminClient,
  clientUuid: string,
  name: string,
): Promise<KeycloakAuthzScopeRep | null> {
  const res = await admin.get(`${resourceServerBase(clientUuid)}/scope?name=${encodeURIComponent(name)}`)
  if (!res.ok) return null
  const list = parseJson<KeycloakAuthzScopeRep[]>(res.body) ?? []
  return findByExactName(list, name)
}

/** List policies by name, optionally scoped to a `type` (e.g. "role"). */
export async function fetchPolicyByName(
  admin: KeycloakAdminClient,
  clientUuid: string,
  name: string,
  type?: string,
): Promise<KeycloakRolePolicyRep | null> {
  const typeQuery = type ? `&type=${encodeURIComponent(type)}` : ''
  const res = await admin.get(`${resourceServerBase(clientUuid)}/policy?name=${encodeURIComponent(name)}${typeQuery}`)
  if (!res.ok) return null
  const list = parseJson<KeycloakRolePolicyRep[]>(res.body) ?? []
  return findByExactName(list, name)
}

/** This config type's role-policy kind only ever addresses `type=role` policies. */
export function fetchRolePolicyByName(
  admin: KeycloakAdminClient,
  clientUuid: string,
  name: string,
): Promise<KeycloakRolePolicyRep | null> {
  return fetchPolicyByName(admin, clientUuid, name, 'role')
}

export async function fetchPermissionByName(
  admin: KeycloakAdminClient,
  clientUuid: string,
  name: string,
): Promise<KeycloakPermissionRep | null> {
  const res = await admin.get(`${resourceServerBase(clientUuid)}/permission?name=${encodeURIComponent(name)}`)
  if (!res.ok) return null
  const list = parseJson<KeycloakPermissionRep[]>(res.body) ?? []
  return findByExactName(list, name)
}

// --- Network: ref resolution (declared name -> {id, name}) --------------------
// Used to resolve names a resource/permission/role-policy REFERENCES (as
// opposed to the fetch*ByName functions above, which resolve an item's OWN
// identity). Layered directly on the fetch functions so there is exactly one
// network implementation per Keycloak list endpoint.

export async function resolveScopeByName(
  admin: KeycloakAdminClient,
  clientUuid: string,
  name: string,
): Promise<KeycloakNamedRef | null> {
  const scope = await fetchScopeByName(admin, clientUuid, name)
  return scope?.id ? { id: scope.id, name: scope.name } : null
}

export async function resolveResourceByName(
  admin: KeycloakAdminClient,
  clientUuid: string,
  name: string,
): Promise<KeycloakNamedRef | null> {
  const resource = await fetchResourceByName(admin, clientUuid, name)
  return resource?.id ? { id: resource.id, name: resource.name } : null
}

/** Resolve a policy name to its ref regardless of policy type (a permission may combine any type). */
export async function resolvePolicyByName(
  admin: KeycloakAdminClient,
  clientUuid: string,
  name: string,
): Promise<KeycloakNamedRef | null> {
  const policy = await fetchPolicyByName(admin, clientUuid, name)
  return policy?.id ? { id: policy.id, name: policy.name } : null
}

/**
 * Resolve one role-policy `roles` entry to its {id, required} ref: a bare name
 * resolves as a REALM role (GET /roles/{name}); a "clientId/roleName" name
 * resolves as a CLIENT role (resolve the client, then GET
 * /clients/{uuid}/roles/{roleName}). Returns null when the role — or, for a
 * client role, the client itself — does not exist.
 */
export async function resolveRoleRef(
  admin: KeycloakAdminClient,
  entry: RoleEntryInput,
): Promise<KeycloakPolicyRoleRef | null> {
  const parsed = parseRoleRefName(entry.name)
  if ('clientId' in parsed) {
    const client = await resolveClientByClientId(admin, parsed.clientId)
    if (!client?.id) return null
    const res = await admin.get(`/clients/${encodeURIComponent(client.id)}/roles/${encodeURIComponent(parsed.roleName)}`)
    if (!res.ok) return null
    const role = parseJson<{ id?: string }>(res.body)
    return role?.id ? { id: role.id, required: entry.required } : null
  }
  const res = await admin.get(`/roles/${encodeURIComponent(parsed.roleName)}`)
  if (!res.ok) return null
  const role = parseJson<{ id?: string }>(res.body)
  return role?.id ? { id: role.id, required: entry.required } : null
}

/** Resolve every declared name, or throw an error naming the first one that does not resolve. */
async function resolveNamedRefs(
  admin: KeycloakAdminClient,
  clientUuid: string,
  names: string[],
  resolver: (admin: KeycloakAdminClient, clientUuid: string, name: string) => Promise<KeycloakNamedRef | null>,
  refLabel: string,
  itemDescription: string,
): Promise<KeycloakNamedRef[]> {
  const refs: KeycloakNamedRef[] = []
  for (const name of names) {
    const ref = await resolver(admin, clientUuid, name)
    if (!ref?.id) throw new Error(`${itemDescription}: ${refLabel} "${name}" not found`)
    refs.push(ref)
  }
  return refs
}

// --- Build request bodies (pure w.r.t. already-resolved refs) ------------------
// `base` (the existing live object, when updating) is spread first so
// Keycloak-managed fields this config type does not author survive an update,
// matching every other config type in this app.

export function buildResourceRep(
  fields: Record<string, unknown>,
  resolvedScopes: KeycloakNamedRef[],
  base?: KeycloakResourceRep,
): KeycloakResourceRep {
  const rep: KeycloakResourceRep = {
    ...(base ?? {}),
    name: readString(fields.name),
    uris: readStringArray(fields.uris),
    scopes: resolvedScopes,
    ownerManagedAccess: readBool(fields.ownerManagedAccess, false),
    attributes: attributesFromKeyValue(readKeyValueMap(fields.attributes)),
  }

  const displayName = readOptionalString(fields.displayName)
  if (displayName !== undefined) rep.displayName = displayName
  else if (base && 'displayName' in base) rep.displayName = base.displayName

  const type = readOptionalString(fields.type)
  if (type !== undefined) rep.type = type
  else if (base && 'type' in base) rep.type = base.type

  return rep
}

export function buildScopeRep(fields: Record<string, unknown>, base?: KeycloakAuthzScopeRep): KeycloakAuthzScopeRep {
  const rep: KeycloakAuthzScopeRep = { ...(base ?? {}), name: readString(fields.name) }

  const displayName = readOptionalString(fields.displayName)
  if (displayName !== undefined) rep.displayName = displayName
  else if (base && 'displayName' in base) rep.displayName = base.displayName

  const iconUri = readOptionalString(fields.iconUri)
  if (iconUri !== undefined) rep.iconUri = iconUri
  else if (base && 'iconUri' in base) rep.iconUri = base.iconUri

  return rep
}

export function buildPermissionRep(
  fields: Record<string, unknown>,
  resolvedPolicies: KeycloakNamedRef[],
  resolvedResources: KeycloakNamedRef[],
  resolvedScopes: KeycloakNamedRef[],
  base?: KeycloakPermissionRep,
): KeycloakPermissionRep {
  const permissionType = readString(fields.permissionType) || 'resource'

  const rep: KeycloakPermissionRep = {
    ...(base ?? {}),
    name: readString(fields.name),
    decisionStrategy: readString(fields.decisionStrategy) || 'UNANIMOUS',
    policies: resolvedPolicies.map((ref) => String(ref.id)),
    scopes: resolvedScopes.map((ref) => String(ref.id)),
  }

  const description = readOptionalString(fields.description)
  if (description !== undefined) rep.description = description
  else if (base && 'description' in base) rep.description = base.description

  if (permissionType === 'resource') {
    rep.resources = resolvedResources.map((ref) => String(ref.id))
    const resourceType = readOptionalString(fields.resourceType)
    if (resourceType !== undefined) rep.resourceType = resourceType
    else if (base && 'resourceType' in base) rep.resourceType = base.resourceType
  }

  return rep
}

export function buildRolePolicyRep(
  fields: Record<string, unknown>,
  resolvedRoles: KeycloakPolicyRoleRef[],
  base?: KeycloakRolePolicyRep,
): KeycloakRolePolicyRep {
  const rep: KeycloakRolePolicyRep = {
    ...(base ?? {}),
    name: readString(fields.name),
    decisionStrategy: readString(fields.decisionStrategy) || 'UNANIMOUS',
    logic: readString(fields.logic) || 'POSITIVE',
    roles: resolvedRoles,
  }

  const description = readOptionalString(fields.description)
  if (description !== undefined) rep.description = description
  else if (base && 'description' in base) rep.description = base.description

  return rep
}

// --- Pure field projections (no network) — used where drift needs no ref resolution ---

export interface ScopeFieldProjection {
  displayName: string | undefined
  iconUri: string | undefined
}

export function projectScopeFields(fields: Record<string, unknown>): ScopeFieldProjection {
  return { displayName: readOptionalString(fields.displayName), iconUri: readOptionalString(fields.iconUri) }
}

// --- Deploy: one network mutation flow per kind ---------------------------------
// Each resolves this item's declared refs, upserts by (kind, name) within the
// resolved client, and returns the {id, priorRep} pair deploy.ts records for
// rollback. Kept here (rather than inline in deploy.ts) so the per-kind flow is
// unit-testable in isolation from the dispatch loop, mirroring how
// default-roles/_shared.ts holds reconcileDefaultRoleComposites and
// groups/_shared.ts holds reconcileRealmRoles.

export interface DeployItemResult {
  /** The object's internal id: pre-existing, newly created, or null if a create's id could not be re-read. */
  id: string | null
  /** The prior representation (update) or null (create) — the rollback.ts input. */
  priorRep: KeycloakAuthorizationRep | null
}

export async function deployResourceItem(
  admin: KeycloakAdminClient,
  clientId: string,
  clientUuid: string,
  fields: Record<string, unknown>,
): Promise<DeployItemResult> {
  const name = readString(fields.name)
  const resolvedScopes = await resolveNamedRefs(
    admin,
    clientUuid,
    readStringArray(fields.scopes),
    resolveScopeByName,
    'scope',
    `resource "${name}" on client "${clientId}"`,
  )

  const base = resourceServerBase(clientUuid)
  const existing = await fetchResourceByName(admin, clientUuid, name)
  if (existing?.id) {
    const rep = buildResourceRep(fields, resolvedScopes, existing)
    const res = await admin.put(`${base}/resource/${encodeURIComponent(existing.id)}`, rep)
    if (!res.ok) throw new Error(`update resource "${name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return { id: existing.id, priorRep: existing }
  }
  const rep = buildResourceRep(fields, resolvedScopes)
  const res = await admin.post(`${base}/resource`, rep)
  if (!res.ok) throw new Error(`create resource "${name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  // Re-fetch by name to capture the id, mirroring this app's other config types
  // (Keycloak's 201 does not reliably surface the id in the response body).
  const created = await fetchResourceByName(admin, clientUuid, name)
  return { id: created?.id ?? null, priorRep: null }
}

export async function deployScopeItem(
  admin: KeycloakAdminClient,
  _clientId: string,
  clientUuid: string,
  fields: Record<string, unknown>,
): Promise<DeployItemResult> {
  const name = readString(fields.name)
  const base = resourceServerBase(clientUuid)
  const existing = await fetchScopeByName(admin, clientUuid, name)
  if (existing?.id) {
    const rep = buildScopeRep(fields, existing)
    const res = await admin.put(`${base}/scope/${encodeURIComponent(existing.id)}`, rep)
    if (!res.ok) throw new Error(`update scope "${name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return { id: existing.id, priorRep: existing }
  }
  const rep = buildScopeRep(fields)
  const res = await admin.post(`${base}/scope`, rep)
  if (!res.ok) throw new Error(`create scope "${name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  const created = await fetchScopeByName(admin, clientUuid, name)
  return { id: created?.id ?? null, priorRep: null }
}

export async function deployPermissionItem(
  admin: KeycloakAdminClient,
  clientId: string,
  clientUuid: string,
  fields: Record<string, unknown>,
): Promise<DeployItemResult> {
  const name = readString(fields.name)
  const permissionType = readString(fields.permissionType) || 'resource'
  const itemDescription = `permission "${name}" on client "${clientId}"`

  const resolvedPolicies = await resolveNamedRefs(
    admin,
    clientUuid,
    readStringArray(fields.policies),
    resolvePolicyByName,
    'policy',
    itemDescription,
  )
  const resolvedScopes = await resolveNamedRefs(
    admin,
    clientUuid,
    readStringArray(fields.scopes),
    resolveScopeByName,
    'scope',
    itemDescription,
  )
  const resolvedResources =
    permissionType === 'resource'
      ? await resolveNamedRefs(
          admin,
          clientUuid,
          readStringArray(fields.resources),
          resolveResourceByName,
          'resource',
          itemDescription,
        )
      : []

  const base = resourceServerBase(clientUuid)
  const existing = await fetchPermissionByName(admin, clientUuid, name)
  if (existing?.id) {
    const rep = buildPermissionRep(fields, resolvedPolicies, resolvedResources, resolvedScopes, existing)
    const res = await admin.put(`${base}/permission/${encodeURIComponent(existing.id)}`, rep)
    if (!res.ok) throw new Error(`update permission "${name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return { id: existing.id, priorRep: existing }
  }
  const rep = buildPermissionRep(fields, resolvedPolicies, resolvedResources, resolvedScopes)
  // UNCONFIRMED assumption for update/delete-by-id above; the CREATE sub-path
  // split below IS verified (PermissionService.java) — see header comment.
  const res = await admin.post(`${base}/permission/${permissionType === 'scope' ? 'scope' : 'resource'}`, rep)
  if (!res.ok) throw new Error(`create permission "${name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  const created = await fetchPermissionByName(admin, clientUuid, name)
  return { id: created?.id ?? null, priorRep: null }
}

export async function deployRolePolicyItem(
  admin: KeycloakAdminClient,
  clientId: string,
  clientUuid: string,
  fields: Record<string, unknown>,
): Promise<DeployItemResult> {
  const name = readString(fields.name)
  const itemDescription = `role-policy "${name}" on client "${clientId}"`

  const { entries, error } = parseRoleEntriesField(fields.roles)
  if (error || !entries) throw new Error(`${itemDescription}: ${error ?? 'invalid roles'}`)

  const resolvedRoles: KeycloakPolicyRoleRef[] = []
  for (const entry of entries) {
    const ref = await resolveRoleRef(admin, entry)
    if (!ref?.id) throw new Error(`${itemDescription}: role "${entry.name}" not found`)
    resolvedRoles.push(ref)
  }

  const base = resourceServerBase(clientUuid)
  const existing = await fetchRolePolicyByName(admin, clientUuid, name)
  if (existing?.id) {
    const rep = buildRolePolicyRep(fields, resolvedRoles, existing)
    const res = await admin.put(`${base}/policy/${encodeURIComponent(existing.id)}`, rep)
    if (!res.ok) throw new Error(`update role-policy "${name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return { id: existing.id, priorRep: existing }
  }
  const rep = buildRolePolicyRep(fields, resolvedRoles)
  const res = await admin.post(`${base}/policy/role`, rep)
  if (!res.ok) throw new Error(`create role-policy "${name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  const created = await fetchRolePolicyByName(admin, clientUuid, name)
  return { id: created?.id ?? null, priorRep: null }
}

/** The {base}/{segment}/{id} path for a rollback restore/delete, per kind. */
export function pathForKind(kind: AuthorizationKind, clientUuid: string, id: string): string {
  const base = resourceServerBase(clientUuid)
  const segment = kind === 'role-policy' ? 'policy' : kind
  return `${base}/${segment}/${encodeURIComponent(id)}`
}
