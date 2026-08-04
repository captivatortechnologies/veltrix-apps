// =============================================================================
// Shared types, GraphQL documents and helpers for the Twingate Connectors
// config type — used by validate / deploy / rollback / driftDetect / healthCheck.
//
// A Connector provides connectivity to a Remote Network. Creating it here only
// registers the Connector object in Twingate — deploying the actual Connector
// process still requires a Connector TOKEN pair (refresh + access token), which
// this app deliberately does NOT manage: `connectorTokenGenerate` mints
// bearer credentials with no declarative "desired state" to diff against
// (the same reasoning this app already applies to Service Account keys).
// Generate tokens directly in Twingate after the Connector is created here.
//
// `remoteNetworkId` is set on CREATE only — `connectorUpdate` has no such
// argument (confirmed via terraform-provider-twingate), so a Connector's
// Remote Network is immutable after creation. If a declared item's resolved
// Remote Network no longer matches the live Connector's, this app fails
// closed (see deploy.ts) rather than silently ignoring the change or
// attempting an unsupported mutation.
//
// GraphQL facts verified against:
//   - https://www.twingate.com/docs/api-overview (endpoint, auth, rate limits)
//   - https://www.twingate.com/docs/api (connectorCreate/Update/Delete input +
//     payload fields, the Connector type's field list, the connectors query shape)
//   - github.com/Twingate/terraform-provider-twingate — the exact mutation
//     variable sets (twingate/internal/client/query/connector-{create,update,
//     delete}.go: `connectorCreate(remoteNetworkId, name, hasStatusNotificationsEnabled)`,
//     `connectorUpdate(id, name, hasStatusNotificationsEnabled)` — no remoteNetworkId)
//     and the live field list (twingate/internal/client/query/connector-read.go).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export interface ConnectorSpec {
  itemName: string
  name: string
  remoteNetworkName: string
  statusUpdatesEnabled: boolean
}

/** A named reference (Remote Network) as returned by its light list query. */
export interface NamedRef {
  id?: string
  name?: string
}

/** The connector's logical identity: its name (case-insensitive, trimmed). */
export function connectorKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function extractConnectorSpecs(canvas: CanvasSnapshot): ConnectorSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      itemName: item.name,
      name: str(fields.name),
      remoteNetworkName: str(fields.remote_network_name),
      statusUpdatesEnabled: readBool(fields.status_updates_enabled, true),
    }
  })
}

// --- GraphQL documents (verified — see file header for sources) ----------------

/** List Connectors — id/name/remoteNetwork/hasStatusNotificationsEnabled is the full managed state. */
export const LIST_CONNECTORS_QUERY = `
query ListConnectors($first: Int, $after: String) {
  connectors(first: $first, after: $after) {
    edges {
      node {
        id
        name
        remoteNetwork {
          id
        }
        hasStatusNotificationsEnabled
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

/** List Remote Networks (light shape) — a connector's `remote_network_name` is resolved to an id by name. */
export const LIST_REMOTE_NETWORKS_QUERY = `
query ListRemoteNetworksForConnectors($first: Int, $after: String) {
  remoteNetworks(first: $first, after: $after) {
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

export const CREATE_CONNECTOR_MUTATION = `
mutation ConnectorCreate($remoteNetworkId: ID!, $name: String, $hasStatusNotificationsEnabled: Boolean) {
  connectorCreate(remoteNetworkId: $remoteNetworkId, name: $name, hasStatusNotificationsEnabled: $hasStatusNotificationsEnabled) {
    ok
    error
    entity {
      id
    }
  }
}`

export const UPDATE_CONNECTOR_MUTATION = `
mutation ConnectorUpdate($id: ID!, $name: String, $hasStatusNotificationsEnabled: Boolean) {
  connectorUpdate(id: $id, name: $name, hasStatusNotificationsEnabled: $hasStatusNotificationsEnabled) {
    ok
    error
    entity {
      id
    }
  }
}`

export const DELETE_CONNECTOR_MUTATION = `
mutation ConnectorDelete($id: ID!) {
  connectorDelete(id: $id) {
    ok
    error
  }
}`

// --- Live-state shapes -----------------------------------------------------------

export interface LiveConnector {
  id?: string
  name?: string
  remoteNetwork?: { id?: string }
  hasStatusNotificationsEnabled?: boolean
}

interface MutationEntity {
  id?: string
}

export interface ConnectorMutationResult {
  ok?: boolean
  error?: string | null
  entity?: MutationEntity | null
}

export interface ConnectorCreateMutationResponse {
  connectorCreate?: ConnectorMutationResult
}

export interface ConnectorUpdateMutationResponse {
  connectorUpdate?: ConnectorMutationResult
}

export interface ConnectorDeleteMutationResponse {
  connectorDelete?: { ok?: boolean; error?: string | null }
}

// --- Input builders ----------------------------------------------------------

export function buildCreateVariables(spec: ConnectorSpec, remoteNetworkId: string): Record<string, unknown> {
  return { remoteNetworkId, name: spec.name, hasStatusNotificationsEnabled: spec.statusUpdatesEnabled }
}

export function buildUpdateVariables(id: string, spec: ConnectorSpec): Record<string, unknown> {
  return { id, name: spec.name, hasStatusNotificationsEnabled: spec.statusUpdatesEnabled }
}

/** Rebuild `connectorUpdate` variables that restore a captured prior live state (for rollback). */
export function priorToUpdateVariables(id: string, prior: LiveConnector): Record<string, unknown> {
  return { id, name: prior.name ?? '', hasStatusNotificationsEnabled: prior.hasStatusNotificationsEnabled ?? true }
}

/** Build a case-insensitive name -> ref lookup from a list of named refs. */
export function byName(refs: NamedRef[]): Map<string, NamedRef> {
  return new Map(refs.filter((r) => r.name && r.id).map((r) => [connectorKey(r.name as string), r]))
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
