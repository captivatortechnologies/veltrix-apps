// =============================================================================
// Shared types, GraphQL documents and helpers for the Twingate Service
// Accounts config type — used by validate / deploy / rollback / driftDetect /
// healthCheck.
//
// A Twingate Service Account is a non-human identity Resources can grant
// access to (via `serviceAccountIds` on a Resource — not yet modeled by this
// app's Resources config type, see its README "Scope"). Its own mutable
// surface is a single field: `name`.
//
// OUT OF SCOPE (deliberately, not guessed at): Service Account KEYS
// (`serviceAccountKeyCreate` / `Update` / `Delete` / `Revoke`) — a key is a
// downloadable credential file, generated once and re-encrypted client-side by
// Twingate; there is nothing to reconcile against a declared spec (unlike
// Wiz's write-only service-account secret, a Twingate key isn't even readable
// as an existence check without listing `keys`, and rotating/expiring one from
// a config-as-code pipeline risks breaking a running workload with no
// declarative "desired state" to diff against). Manage keys directly in
// Twingate.
//
// GraphQL facts verified against:
//   - https://www.twingate.com/docs/api-overview (endpoint, auth, rate limits)
//   - https://www.twingate.com/docs/api (serviceAccountCreate/Update/Delete
//     input + payload fields, the ServiceAccount type's field list, the
//     serviceAccounts query shape)
//   - github.com/Twingate/terraform-provider-twingate — the exact mutation
//     variable sets (twingate/internal/client/query/service-account-{create,
//     update,delete}.go)
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export interface ServiceAccountSpec {
  itemName: string
  name: string
}

/** The service account's logical identity: its name (case-insensitive, trimmed). */
export function serviceAccountKey(name: string): string {
  return name.trim().toLowerCase()
}

export function extractServiceAccountSpecs(canvas: CanvasSnapshot): ServiceAccountSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return { itemName: item.name, name: str(fields.name) }
  })
}

// --- GraphQL documents (verified — see file header for sources) ----------------

export const LIST_SERVICE_ACCOUNTS_QUERY = `
query ListServiceAccounts($first: Int, $after: String) {
  serviceAccounts(first: $first, after: $after) {
    edges {
      node {
        id
        name
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

export const CREATE_SERVICE_ACCOUNT_MUTATION = `
mutation ServiceAccountCreate($name: String!) {
  serviceAccountCreate(name: $name) {
    ok
    error
    entity {
      id
    }
  }
}`

export const UPDATE_SERVICE_ACCOUNT_MUTATION = `
mutation ServiceAccountUpdate($id: ID!, $name: String) {
  serviceAccountUpdate(id: $id, name: $name) {
    ok
    error
    entity {
      id
    }
  }
}`

export const DELETE_SERVICE_ACCOUNT_MUTATION = `
mutation ServiceAccountDelete($id: ID!) {
  serviceAccountDelete(id: $id) {
    ok
    error
  }
}`

// --- Live-state shapes -----------------------------------------------------------

export interface LiveServiceAccount {
  id?: string
  name?: string
}

interface MutationEntity {
  id?: string
}

export interface ServiceAccountMutationResult {
  ok?: boolean
  error?: string | null
  entity?: MutationEntity | null
}

export interface ServiceAccountCreateMutationResponse {
  serviceAccountCreate?: ServiceAccountMutationResult
}

export interface ServiceAccountUpdateMutationResponse {
  serviceAccountUpdate?: ServiceAccountMutationResult
}

export interface ServiceAccountDeleteMutationResponse {
  serviceAccountDelete?: { ok?: boolean; error?: string | null }
}

// --- Input builders ----------------------------------------------------------

export function buildCreateVariables(spec: ServiceAccountSpec): Record<string, unknown> {
  return { name: spec.name }
}

export function buildUpdateVariables(id: string, spec: ServiceAccountSpec): Record<string, unknown> {
  return { id, name: spec.name }
}

/** Rebuild `serviceAccountUpdate` variables that restore a captured prior state (for rollback). */
export function priorToUpdateVariables(id: string, prior: LiveServiceAccount): Record<string, unknown> {
  return { id, name: prior.name ?? '' }
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
