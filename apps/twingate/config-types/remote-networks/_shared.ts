// =============================================================================
// Shared types, GraphQL documents and helpers for the Twingate Remote Networks
// config type — used by validate / deploy / rollback / driftDetect / healthCheck.
//
// A Remote Network is the routing boundary a Connector (and the Resources it
// exposes) belongs to. Unlike Resource, RemoteNetwork is a concrete GraphQL
// type (no interface / inline-fragment indirection) and its managed state is
// small enough that the list query alone carries everything a deploy needs —
// no separate per-id "full read" step.
//
// GraphQL facts verified against:
//   - https://www.twingate.com/docs/api-overview (endpoint, auth, rate limits)
//   - https://www.twingate.com/docs/api (remoteNetworkCreate/Update/Delete input
//     + payload fields, the RemoteNetwork type's field list, the remoteNetworks
//     query shape)
//   - github.com/Twingate/terraform-provider-twingate — the exact mutation
//     variable sets (twingate/internal/client/query/remote-network-{create,
//     update,delete}.go) and the `Location` / `RemoteNetworkType` enum values
//     (AWS/AZURE/GOOGLE_CLOUD/ON_PREMISE/OTHER and REGULAR/EXIT — confirmed in
//     twingate/internal/model/remote-network.go).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const LOCATIONS = ['OTHER', 'AWS', 'AZURE', 'GOOGLE_CLOUD', 'ON_PREMISE'] as const
export const NETWORK_TYPES = ['REGULAR', 'EXIT'] as const

export interface RemoteNetworkSpec {
  itemName: string
  name: string
  location: string
  networkType: string
  isActive: boolean
}

/** The remote network's logical identity: its name (case-insensitive, trimmed). */
export function networkKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function extractRemoteNetworkSpecs(canvas: CanvasSnapshot): RemoteNetworkSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      itemName: item.name,
      name: str(fields.name),
      location: str(fields.location) || 'OTHER',
      networkType: str(fields.network_type) || 'REGULAR',
      isActive: readBool(fields.is_active, true),
    }
  })
}

// --- GraphQL documents (verified — see file header for sources) ----------------

/** List Remote Networks — the list query carries the full managed state (no separate read). */
export const LIST_REMOTE_NETWORKS_QUERY = `
query ListRemoteNetworks($first: Int, $after: String) {
  remoteNetworks(first: $first, after: $after) {
    edges {
      node {
        id
        name
        location
        networkType
        isActive
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

export const CREATE_REMOTE_NETWORK_MUTATION = `
mutation RemoteNetworkCreate($name: String!, $location: RemoteNetworkLocation, $networkType: RemoteNetworkType, $isActive: Boolean) {
  remoteNetworkCreate(name: $name, location: $location, networkType: $networkType, isActive: $isActive) {
    ok
    error
    entity {
      id
    }
  }
}`

export const UPDATE_REMOTE_NETWORK_MUTATION = `
mutation RemoteNetworkUpdate($id: ID!, $name: String, $location: RemoteNetworkLocation, $networkType: RemoteNetworkType, $isActive: Boolean) {
  remoteNetworkUpdate(id: $id, name: $name, location: $location, networkType: $networkType, isActive: $isActive) {
    ok
    error
    entity {
      id
    }
  }
}`

export const DELETE_REMOTE_NETWORK_MUTATION = `
mutation RemoteNetworkDelete($id: ID!) {
  remoteNetworkDelete(id: $id) {
    ok
    error
  }
}`

// --- Live-state shapes -----------------------------------------------------------

/** A remote network as returned by the (single, full-state) list query. */
export interface LiveRemoteNetwork {
  id?: string
  name?: string
  location?: string
  networkType?: string
  isActive?: boolean
}

interface MutationEntity {
  id?: string
}

export interface RemoteNetworkMutationResult {
  ok?: boolean
  error?: string | null
  entity?: MutationEntity | null
}

export interface RemoteNetworkCreateMutationResponse {
  remoteNetworkCreate?: RemoteNetworkMutationResult
}

export interface RemoteNetworkUpdateMutationResponse {
  remoteNetworkUpdate?: RemoteNetworkMutationResult
}

export interface RemoteNetworkDeleteMutationResponse {
  remoteNetworkDelete?: { ok?: boolean; error?: string | null }
}

// --- Input builders ----------------------------------------------------------

export function buildCreateVariables(spec: RemoteNetworkSpec): Record<string, unknown> {
  return { name: spec.name, location: spec.location, networkType: spec.networkType, isActive: spec.isActive }
}

export function buildUpdateVariables(id: string, spec: RemoteNetworkSpec): Record<string, unknown> {
  return { id, ...buildCreateVariables(spec) }
}

/** Rebuild `remoteNetworkUpdate` variables that restore a captured prior live state (for rollback). */
export function priorToUpdateVariables(id: string, prior: LiveRemoteNetwork): Record<string, unknown> {
  return {
    id,
    name: prior.name ?? '',
    location: prior.location ?? 'OTHER',
    networkType: prior.networkType ?? 'REGULAR',
    isActive: prior.isActive ?? true,
  }
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
