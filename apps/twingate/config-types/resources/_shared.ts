// =============================================================================
// Shared types, GraphQL documents and helpers for the Twingate Resources config
// type — used by validate / deploy / rollback / driftDetect / healthCheck.
//
// A Twingate "Resource" is a private application, host or subnet reachable
// through a Remote Network's Connector(s). The base `resourceCreate` /
// `resourceUpdate` / `resourceDelete` mutations and the `resources` / `resource`
// queries operate on the generic resource kind, whose concrete GraphQL type is
// `NetworkResource` (Twingate also has specialized SSHResource /
// KubernetesResource / WebAppResource kinds with their own mutations — out of
// scope here; see README "Scope").
//
// GraphQL facts verified against:
//   - https://www.twingate.com/docs/api-overview (endpoint, auth, rate limits)
//   - https://www.twingate.com/docs/api (resourceCreate/Update/Delete input +
//     payload fields, the Resource type's field list, the resources/remoteNetworks/
//     groups query shapes)
//   - github.com/Twingate/terraform-provider-twingate (tested, Twingate-maintained
//     Go client) for the exact selection-set mechanics: the `Resource` interface's
//     base fields are only reachable through an inline fragment on the concrete
//     `NetworkResource` type (`... on NetworkResource { ... }`), confirmed in
//     twingate/internal/client/query/resource-read.go and resources-read.go; and
//     for the ProtocolPolicy enum values (RESTRICTED / ALLOW_ALL / DENY_ALL),
//     confirmed in twingate/internal/model/resource.go.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

// --- Enums / constants ---------------------------------------------------------

/** `ProtocolPolicy` enum values — confirmed via terraform-provider-twingate's model.go. */
export const PROTOCOL_POLICIES = ['ALLOW_ALL', 'RESTRICTED', 'DENY_ALL'] as const
export type ProtocolPolicy = (typeof PROTOCOL_POLICIES)[number]

const MIN_PORT = 1
const MAX_PORT = 65535

// --- Canvas extraction ----------------------------------------------------------

export interface PortRangeSpec {
  start: number
  end: number
}

export interface ResourceSpec {
  /** The canvas item's own label (for error/message prefixes), distinct from `name`. */
  itemName: string
  name: string
  address: string
  remoteNetworkName: string
  alias: string
  isVisible: boolean
  isBrowserShortcutEnabled: boolean
  allowIcmp: boolean
  tcpPolicy: string
  tcpPorts: string[]
  udpPolicy: string
  udpPorts: string[]
  groupNames: string[]
}

/** The resource's logical identity: its name (case-insensitive, trimmed). */
export function resourceKey(name: string): string {
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

/**
 * Parse one port-list entry: either a single port ("443") or an inclusive
 * range ("8000-9000"). Returns null when the entry is malformed or out of the
 * valid TCP/UDP port range (1-65535) — mirrors terraform-provider-twingate's
 * own port validation bounds (model/validation.go).
 */
export function parsePortRangeEntry(raw: string): PortRangeSpec | null {
  const trimmed = raw.trim()
  const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/)
  if (rangeMatch) {
    const start = Number(rangeMatch[1])
    const end = Number(rangeMatch[2])
    if (!isValidPort(start) || !isValidPort(end) || start > end) return null
    return { start, end }
  }
  if (/^\d+$/.test(trimmed)) {
    const port = Number(trimmed)
    if (!isValidPort(port)) return null
    return { start: port, end: port }
  }
  return null
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT
}

/** Parse a list of port-list entries, separating the valid ranges from the malformed raw strings. */
export function parsePortRanges(entries: string[]): { ranges: PortRangeSpec[]; invalid: string[] } {
  const ranges: PortRangeSpec[] = []
  const invalid: string[] = []
  for (const entry of entries) {
    const parsed = parsePortRangeEntry(entry)
    if (parsed) ranges.push(parsed)
    else invalid.push(entry)
  }
  return { ranges, invalid }
}

/** Each canvas item describes one Twingate Resource. */
export function extractResourceSpecs(canvas: CanvasSnapshot): ResourceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      itemName: item.name,
      name: str(fields.name),
      address: str(fields.address),
      remoteNetworkName: str(fields.remote_network_name),
      alias: str(fields.alias),
      isVisible: readBool(fields.is_visible, true),
      isBrowserShortcutEnabled: readBool(fields.is_browser_shortcut_enabled, false),
      allowIcmp: readBool(fields.allow_icmp, true),
      tcpPolicy: str(fields.tcp_policy) || 'ALLOW_ALL',
      tcpPorts: strList(fields.tcp_ports),
      udpPolicy: str(fields.udp_policy) || 'ALLOW_ALL',
      udpPorts: strList(fields.udp_ports),
      groupNames: strList(fields.group_names),
    }
  })
}

// --- GraphQL documents (verified — see file header for sources) ----------------

/** List resources (Relay connection, `id`/`name` only — full state is read per-match). */
export const LIST_RESOURCES_QUERY = `
query ListResources($first: Int, $after: String) {
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

/** Read a single resource's full managed state (for update-diffing + rollback restore). */
export const GET_RESOURCE_QUERY = `
query GetResource($id: ID!) {
  resource(id: $id) {
    ... on NetworkResource {
      id
      name
      address {
        value
      }
      alias
      remoteNetwork {
        id
        name
      }
      protocols {
        allowIcmp
        tcp {
          policy
          ports {
            start
            end
          }
        }
        udp {
          policy
          ports {
            start
            end
          }
        }
      }
      isActive
      isVisible
      isBrowserShortcutEnabled
      groups(first: 200) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  }
}`

/** List Remote Networks (Relay connection) — resources are resolved to one by name. */
export const LIST_REMOTE_NETWORKS_QUERY = `
query ListRemoteNetworks($first: Int, $after: String) {
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

/** List Groups (Relay connection) — a resource's access list is resolved to ids by name. */
export const LIST_GROUPS_QUERY = `
query ListGroups($first: Int, $after: String) {
  groups(first: $first, after: $after) {
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

export const CREATE_RESOURCE_MUTATION = `
mutation ResourceCreate(
  $name: String!
  $address: String!
  $remoteNetworkId: ID!
  $protocols: ProtocolsInput
  $alias: String
  $isVisible: Boolean
  $isBrowserShortcutEnabled: Boolean
  $groupIds: [ID]
) {
  resourceCreate(
    name: $name
    address: $address
    remoteNetworkId: $remoteNetworkId
    protocols: $protocols
    alias: $alias
    isVisible: $isVisible
    isBrowserShortcutEnabled: $isBrowserShortcutEnabled
    groupIds: $groupIds
  ) {
    ok
    error
    entity {
      ... on NetworkResource {
        id
      }
    }
  }
}`

export const UPDATE_RESOURCE_MUTATION = `
mutation ResourceUpdate(
  $id: ID!
  $name: String
  $address: String
  $remoteNetworkId: ID
  $protocols: ProtocolsInput
  $alias: String
  $isVisible: Boolean
  $isBrowserShortcutEnabled: Boolean
  $groupIds: [ID]
) {
  resourceUpdate(
    id: $id
    name: $name
    address: $address
    remoteNetworkId: $remoteNetworkId
    protocols: $protocols
    alias: $alias
    isVisible: $isVisible
    isBrowserShortcutEnabled: $isBrowserShortcutEnabled
    groupIds: $groupIds
  ) {
    ok
    error
    entity {
      ... on NetworkResource {
        id
      }
    }
  }
}`

export const DELETE_RESOURCE_MUTATION = `
mutation ResourceDelete($id: ID!) {
  resourceDelete(id: $id) {
    ok
    error
  }
}`

// --- Live-state shapes -----------------------------------------------------------

/** A resource as returned by the light `resources` list query. */
export interface LiveResource {
  id?: string
  name?: string
}

/** A named reference (Remote Network or Group) as returned by their list queries. */
export interface NamedRef {
  id?: string
  name?: string
}

export interface LiveProtocol {
  policy?: string
  ports?: Array<{ start?: number; end?: number }>
}

export interface LiveProtocols {
  allowIcmp?: boolean
  tcp?: LiveProtocol
  udp?: LiveProtocol
}

/** A resource as returned by the full `resource(id)` read query. */
export interface FullResource {
  id?: string
  name?: string
  address?: { value?: string }
  alias?: string | null
  remoteNetwork?: { id?: string; name?: string }
  protocols?: LiveProtocols
  isActive?: boolean
  isVisible?: boolean
  isBrowserShortcutEnabled?: boolean
  groups?: { edges?: Array<{ node?: NamedRef | null } | null> }
}

interface MutationEntity {
  id?: string
}

export interface ResourceMutationResult {
  ok?: boolean
  error?: string | null
  entity?: MutationEntity | null
}

export interface ResourceCreateMutationResponse {
  resourceCreate?: ResourceMutationResult
}

export interface ResourceUpdateMutationResponse {
  resourceUpdate?: ResourceMutationResult
}

export interface ResourceDeleteMutationResponse {
  resourceDelete?: { ok?: boolean; error?: string | null }
}

// --- Input builders ----------------------------------------------------------

/** The `ProtocolsInput` for a spec. */
export function buildProtocolsInput(spec: ResourceSpec): Record<string, unknown> {
  return {
    allowIcmp: spec.allowIcmp,
    tcp: protocolInput(spec.tcpPolicy, spec.tcpPorts),
    udp: protocolInput(spec.udpPolicy, spec.udpPorts),
  }
}

function protocolInput(policy: string, ports: string[]): Record<string, unknown> {
  const { ranges } = parsePortRanges(ports)
  return {
    policy,
    ports: ranges.map((r) => ({ start: r.start, end: r.end })),
  }
}

/** The `resourceCreate` mutation variables for a spec. */
export function buildCreateVariables(
  spec: ResourceSpec,
  remoteNetworkId: string,
  groupIds: string[],
): Record<string, unknown> {
  return {
    name: spec.name,
    address: spec.address,
    remoteNetworkId,
    protocols: buildProtocolsInput(spec),
    alias: spec.alias || null,
    isVisible: spec.isVisible,
    isBrowserShortcutEnabled: spec.isBrowserShortcutEnabled,
    groupIds,
  }
}

/** The `resourceUpdate` mutation variables for a spec (same managed fields as create, plus `id`). */
export function buildUpdateVariables(
  id: string,
  spec: ResourceSpec,
  remoteNetworkId: string,
  groupIds: string[],
): Record<string, unknown> {
  return { id, ...buildCreateVariables(spec, remoteNetworkId, groupIds) }
}

/** Rebuild `resourceUpdate` variables that restore a captured prior full-resource state (for rollback). */
export function priorToUpdateVariables(id: string, prior: FullResource): Record<string, unknown> {
  return {
    id,
    name: prior.name ?? '',
    address: prior.address?.value ?? '',
    remoteNetworkId: prior.remoteNetwork?.id ?? '',
    protocols: {
      allowIcmp: prior.protocols?.allowIcmp ?? true,
      tcp: priorProtocolInput(prior.protocols?.tcp),
      udp: priorProtocolInput(prior.protocols?.udp),
    },
    alias: prior.alias || null,
    isVisible: prior.isVisible ?? true,
    isBrowserShortcutEnabled: prior.isBrowserShortcutEnabled ?? false,
    groupIds: groupIdsFromFull(prior),
  }
}

function priorProtocolInput(protocol: LiveProtocol | undefined): Record<string, unknown> {
  return {
    policy: protocol?.policy ?? 'ALLOW_ALL',
    ports: (protocol?.ports ?? [])
      .filter((p): p is { start: number; end: number } => typeof p.start === 'number' && typeof p.end === 'number')
      .map((p) => ({ start: p.start, end: p.end })),
  }
}

/** Extract the group ids a full resource read currently has access granted to. */
export function groupIdsFromFull(full: FullResource): string[] {
  const edges = full.groups?.edges ?? []
  return edges
    .map((e) => e?.node?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** Extract the group names a full resource read currently has access granted to. */
export function groupNamesFromFull(full: FullResource): string[] {
  const edges = full.groups?.edges ?? []
  return edges
    .map((e) => e?.node?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

// --- Named-reference resolution (Remote Networks / Groups, by name) ------------

/** Build a case-insensitive name -> ref lookup from a list of named refs. */
export function byName(refs: NamedRef[]): Map<string, NamedRef> {
  return new Map(refs.filter((r) => r.name && r.id).map((r) => [resourceKey(r.name as string), r]))
}

/** Sort + join a set of port ranges into a stable, comparable string (drift comparisons). */
export function portsSignature(ports: Array<{ start?: number; end?: number }> | undefined): string {
  return (ports ?? [])
    .filter((p) => typeof p.start === 'number' && typeof p.end === 'number')
    .map((p) => `${p.start}-${p.end}`)
    .sort()
    .join(',')
}

/** Sort + join a declared port-list spec into the same comparable shape as `portsSignature`. */
export function declaredPortsSignature(ports: string[]): string {
  const { ranges } = parsePortRanges(ports)
  return ranges
    .map((r) => `${r.start}-${r.end}`)
    .sort()
    .join(',')
}

/** Sort + join a set of ids/names into a stable, comparable string (drift/set comparisons). */
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
