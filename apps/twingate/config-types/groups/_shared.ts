// =============================================================================
// Shared types, GraphQL documents and helpers for the Twingate Groups config
// type — used by validate / deploy / rollback / driftDetect / healthCheck.
//
// A Twingate Group grants its members access to the Resources assigned to it.
// Groups have a `type` Twingate itself sets (MANUAL / SYNCED / SYSTEM) — only
// MANUAL groups are created through the API; SYNCED groups come from a
// connected IdP and SYSTEM groups are Twingate built-ins (e.g. "Everyone").
// Reconciliation therefore matches an existing group by name ONLY among MANUAL
// groups — a same-named SYNCED/SYSTEM group is left untouched and reported as
// an error (see deploy.ts), mirroring how other Veltrix apps (e.g. Wiz's
// cloud-config-rules) exclude built-in objects from reconciliation.
//
// Members are managed by Resource, not by User: this app resolves
// `resource_names` (by name) to `resourceIds` (full-replacement, like the
// Resources config type's `group_names`). User membership is deliberately
// OUT OF SCOPE for v0.2.0 (see README "Scope") — Twingate Groups are usually
// populated by IdP sync or direct invitation, not Infrastructure-as-Code.
//
// GraphQL facts verified against:
//   - https://www.twingate.com/docs/api-overview (endpoint, auth, rate limits)
//   - https://www.twingate.com/docs/api (groupCreate/Update/Delete input +
//     payload fields, the Group type's field list, the groups query shape)
//   - github.com/Twingate/terraform-provider-twingate — the exact mutation
//     variable sets (twingate/internal/client/query/group-{create,update,
//     delete}.go) and the Group `type` constants MANUAL/SYNCED/SYSTEM
//     (twingate/internal/model/group.go).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** Group `type` values Twingate itself assigns — never sent on create/update. */
export const GROUP_TYPE_MANUAL = 'MANUAL'
export const GROUP_TYPE_SYNCED = 'SYNCED'
export const GROUP_TYPE_SYSTEM = 'SYSTEM'

export interface GroupSpec {
  itemName: string
  name: string
  isActive: boolean
  resourceNames: string[]
}

/** A named reference (Resource) as returned by the light resources list query. */
export interface NamedRef {
  id?: string
  name?: string
}

/** The group's logical identity: its name (case-insensitive, trimmed). */
export function groupKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a canvas value that may be a `tags` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

export function extractGroupSpecs(canvas: CanvasSnapshot): GroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      itemName: item.name,
      name: str(fields.name),
      isActive: readBool(fields.is_active, true),
      resourceNames: strList(fields.resource_names),
    }
  })
}

// --- GraphQL documents (verified — see file header for sources) ----------------

/** List Groups, including each group's current Resource access (small enough to inline). */
export const LIST_GROUPS_QUERY = `
query ListGroups($first: Int, $after: String) {
  groups(first: $first, after: $after) {
    edges {
      node {
        id
        name
        isActive
        type
        resources(first: 200) {
          edges {
            node {
              ... on NetworkResource {
                id
                name
              }
            }
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

/** List Resources (light shape) — a group's `resource_names` are resolved to ids by name. */
export const LIST_RESOURCES_QUERY = `
query ListResourcesForGroups($first: Int, $after: String) {
  resources(first: $first, after: $after) {
    edges {
      node {
        ... on NetworkResource {
          id
          name
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

export const CREATE_GROUP_MUTATION = `
mutation GroupCreate($name: String!, $resourceIds: [ID]) {
  groupCreate(name: $name, resourceIds: $resourceIds) {
    ok
    error
    entity {
      id
    }
  }
}`

export const UPDATE_GROUP_MUTATION = `
mutation GroupUpdate($id: ID!, $name: String, $isActive: Boolean, $resourceIds: [ID]) {
  groupUpdate(id: $id, name: $name, isActive: $isActive, resourceIds: $resourceIds) {
    ok
    error
    entity {
      id
    }
  }
}`

export const DELETE_GROUP_MUTATION = `
mutation GroupDelete($id: ID!) {
  groupDelete(id: $id) {
    ok
    error
  }
}`

// --- Live-state shapes -----------------------------------------------------------

export interface LiveGroup {
  id?: string
  name?: string
  isActive?: boolean
  type?: string
  resources?: { edges?: Array<{ node?: NamedRef | null } | null> }
}

interface MutationEntity {
  id?: string
}

export interface GroupMutationResult {
  ok?: boolean
  error?: string | null
  entity?: MutationEntity | null
}

export interface GroupCreateMutationResponse {
  groupCreate?: GroupMutationResult
}

export interface GroupUpdateMutationResponse {
  groupUpdate?: GroupMutationResult
}

export interface GroupDeleteMutationResponse {
  groupDelete?: { ok?: boolean; error?: string | null }
}

/** True when Twingate itself owns this group's membership (never matched/updated by this app). */
export function isExternallyManaged(type: string | undefined): boolean {
  return type === GROUP_TYPE_SYNCED || type === GROUP_TYPE_SYSTEM
}

// --- Input builders ----------------------------------------------------------

export function buildGroupCreateVariables(spec: GroupSpec, resourceIds: string[]): Record<string, unknown> {
  return { name: spec.name, resourceIds }
}

export function buildGroupUpdateVariables(id: string, spec: GroupSpec, resourceIds: string[]): Record<string, unknown> {
  return { id, name: spec.name, isActive: spec.isActive, resourceIds }
}

/** Rebuild `groupUpdate` variables that restore a captured prior full group state (for rollback). */
export function priorToUpdateVariables(id: string, prior: LiveGroup): Record<string, unknown> {
  return {
    id,
    name: prior.name ?? '',
    isActive: prior.isActive ?? true,
    resourceIds: resourceIdsFromGroup(prior),
  }
}

/** Extract the resource ids a live group currently has access to. */
export function resourceIdsFromGroup(group: LiveGroup): string[] {
  const edges = group.resources?.edges ?? []
  return edges.map((e) => e?.node?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** Build a case-insensitive name -> ref lookup from a list of named refs. */
export function byName(refs: NamedRef[]): Map<string, NamedRef> {
  return new Map(refs.filter((r) => r.name && r.id).map((r) => [groupKey(r.name as string), r]))
}

/** Sort + join a set of ids into a stable, comparable string (drift/set comparisons). */
export function idSetSignature(ids: string[]): string {
  return [...new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean))].sort().join(',')
}

/** Throw a descriptive error when a GraphQL call failed at the transport, GraphQL, or ok/error level. */
export function assertMutationOk(
  transportError: string | null,
  errors: { message?: string }[] | null,
  okError: string | null,
  action: string,
): void {
  if (transportError) throw new Error(`Failed to ${action}: ${transportError}`)
  if (errors) throw new Error(`Failed to ${action}: ${errors.map((e) => e.message || 'error').join('; ')}`)
  if (okError) throw new Error(`Failed to ${action}: ${okError}`)
}
