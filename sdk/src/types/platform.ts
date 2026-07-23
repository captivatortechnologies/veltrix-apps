// ========================================================================
// Platform types available to app developers
// These represent the data apps receive from the platform
// ========================================================================

import type { AppManifest } from './manifest'

export interface Component {
  id: string
  hostname: string
  port: string
  type: string[]
  toolId: string
  customerId: string
}

/**
 * An Inventory item — one deployment target an app can deploy configuration to.
 *
 * "Inventory" is the app-facing name for the platform's *components*: the
 * servers (hostname/port), domains, and IP/CIDR ranges a customer has
 * registered as deploy targets. This is a convenient, typed surface over the
 * platform's components API (`/api/components`), enriched with `domains` and
 * `ipRanges`. Use the helpers in `@veltrixsecops/app-sdk/client`
 * (listInventory / addInventoryItem / updateInventoryItem / removeInventoryItem).
 */
export interface InventoryItem {
  id: string
  /** Server hostname or DNS name of the target. */
  hostname: string
  /** Management/API port, as a string (e.g. "8089"). */
  port?: string
  /** Optional secondary service port, e.g. a web UI (Splunk Web "8000"). */
  webPort?: string | null
  /** Component type tags (e.g. ["server"]) that classify the target. */
  type?: string[]
  /** DNS names this target is reachable at. */
  domains?: string[]
  /** IP addresses or CIDR ranges this target covers. */
  ipRanges?: string[]
  /** Platform tags attached to this target. */
  tags?: { id: string; name: string }[]
  /** Assigned connectivity provider (ZTNA), or null when none is configured. */
  connectivityProviderId?: string | null
  /** Linked Connection (credential) used to reach this target, or null. */
  credentialId?: string | null
}

/**
 * Input accepted by `addInventoryItem` / `updateInventoryItem`. Mirrors the
 * platform components API create/update body: `hostname` and `port` identify
 * the server, `domains`/`ipRanges` enrich it, and `tagIds` attaches existing
 * platform tags. `toolId` is required by the platform on create — pass the
 * tool id your app registers targets under.
 */
export interface InventoryItemInput {
  hostname: string
  port?: string
  /** Optional secondary service port, e.g. a web UI (Splunk Web "8000"). */
  webPort?: string | null
  type?: string[]
  domains?: string[]
  ipRanges?: string[]
  /** IDs of existing platform tags to attach to the target. */
  tagIds?: string[]
  /** The tool this target belongs to. Required by the platform on create. */
  toolId?: string
  /** Assigned connectivity provider (ZTNA), or null to unlink. */
  connectivityProviderId?: string | null
  /** Linked Connection (credential) used to reach this target, or null. */
  credentialId?: string | null
}

/**
 * A lightweight reference to a ZTNA connectivity provider, as returned by the
 * platform's `/api/connectivity-providers` endpoint. Used to populate the ZTNA
 * link picker when creating or editing an Access Server (a component).
 */
export interface ConnectivityProviderRef {
  id: string
  name: string
  providerType?: string
  status?: string
}

export interface Credential {
  id: string
  name: string
  username: string
  password: string
  apiToken: string | null
  certificate: string | null
  endpoint: string | null
  toolId: string
  customerId: string
}

/**
 * A redacted view of a {@link Credential}, as returned by the SDK's
 * `listCredentials` helper. Secret material (password / apiToken / certificate)
 * is deliberately dropped so it never enters app code or logs — only whether a
 * secret is present is surfaced, via {@link CredentialSummary.hasSecret}. Used
 * to pair a credential with its server (a "connection") for display.
 */
export interface CredentialSummary {
  id: string
  /** Human-readable label of the connection. */
  name: string
  /** Account / client id the credential authenticates as. */
  username: string
  /** Auth kind (e.g. "password", "token"), or null when unspecified. */
  type: string | null
  /** API base URL / endpoint this connection authenticates to, or null. */
  endpoint: string | null
  /** The tool this credential belongs to. */
  toolId: string
  /** True when a write-only secret (apiToken or password) is stored. */
  hasSecret: boolean
  /** Platform tags — the environment(s) this connection is tied to. */
  tags: { id: string; name: string }[]
}

/**
 * Input accepted by `createCredential` / `updateCredential`. Mirrors the
 * platform credentials API body. `name`, `username`, and `password` are
 * required by the platform on create (`password` may be an empty string for
 * token-only auth); the write-only secret travels in `apiToken`. `toolId` is
 * required on create — pass the id your app registers connections under.
 */
export interface CredentialInput {
  name: string
  username: string
  password: string
  apiToken?: string
  type?: string
  /** API base URL / endpoint this connection authenticates to. Not a secret. */
  endpoint?: string
  /** The tool this credential belongs to. Required by the platform on create. */
  toolId?: string
  /** IDs of existing platform tags to attach to the credential. */
  tagIds?: string[]
}

export interface Connectivity {
  id: string
  componentId: string
  status: string
  sshCommand: string | null
  httpsUrl: string | null
  tailscaleDeviceIP: string | null
}

export interface Tag {
  id: string
  name: string
  customerId: string
}

export interface User {
  id: string
  email: string
  name: string | null
  customerId: string
  roleId: string
}

export interface Customer {
  id: string
  name: string
  domain: string | null
  isActive: boolean
}

// --- Client-side permission checks (RBAC/IdP hardening, Wave C4) ---
//
// Mirrors the platform's client permission store (client/src/stores/
// permissionStore.ts), itself an exact mirror of the platform server's
// RBAC resolver (server/src/lib/permissions.ts). Exposed on
// `AppContextValue.permissions` (see hooks/use-app-context.ts) and the host
// runtime's own `VeltrixHostRuntime.permissions` (see client/index.ts).

/** One resolved permission entry the signed-in user's role grants. */
export interface PermissionEntry {
  resource: string
  action: string
  /** null = platform-scoped; a real App.id = scoped to that app. */
  appId: string | null
}

export interface PermissionCheckOptions {
  /**
   * App-scoped check target. On `AppContextValue.permissions.has()` this
   * defaults to the CURRENT app's own id when omitted (apps check their own
   * declared resources by default) — pass `null` explicitly for a platform
   * resource, or another app's id to check a different app. On the
   * top-level `VeltrixHostRuntime.permissions.has()` there is no such
   * default (omit for a platform-scoped check).
   */
  appId?: string | null
}

/**
 * Permission-check surface. `has()` is fail-closed: `false` for anything
 * not explicitly granted (including `all:all`/`resource:all` wildcards and
 * the platform-admin bypass — all resolved server-side, mirrored client-side
 * exactly).
 */
export interface AppPermissionsApi {
  has: (resource: string, action: string, opts?: PermissionCheckOptions) => boolean
  list: () => PermissionEntry[]
}

// --- Lifecycle hook types ---

/**
 * Loosely-typed handle to the platform database, passed to lifecycle hooks.
 * At runtime this is the platform's Prisma client; model delegates are
 * accessed by name (e.g. `db.splunkVersion.upsert(...)` for an app table).
 * Apps should only touch their own prefixed tables and the raw-query
 * escape hatches — anything else is unsupported and may break between
 * platform versions.
 */
export interface PlatformDatabaseClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
  [modelDelegate: string]: any
}

/**
 * Context passed to app lifecycle hooks
 * (onInstall / onUninstall / onEnable / onDisable / onUpgrade).
 * `customerId` is present only for customer-scoped hooks (onEnable/onDisable).
 */
export interface AppHookContext {
  db: PlatformDatabaseClient
  appId: string
  customerId?: string
}

/**
 * Context passed to an app's `onWebhook` hook when the platform receives an
 * inbound webhook. The platform stays ignorant of the app's semantics — the
 * app inspects `source`/`event` and decides whether and how to act (e.g. update
 * its own tables via `db`).
 */
export interface AppWebhookContext {
  db: PlatformDatabaseClient
  appId: string
  /** Origin of the webhook, e.g. 'github'. */
  source: string
  /** Event name within the source, e.g. 'deployment'. */
  event: string
  /** Normalized webhook payload. */
  payload: any
}

/**
 * Context passed to an app's `onEvent` hook when the platform routes a message-
 * bus event to it. Symmetric with `events.publish` (outbound): the app inspects
 * `topic` and acts on its own data.
 */
export interface AppEventContext {
  db: PlatformDatabaseClient
  appId: string
  /** Event topic, e.g. 'deployment.status'. */
  topic: string
  /** Event payload. */
  payload: any
}

/**
 * Publish an event/message from an app to the platform's message bus. The
 * platform routes it on a topic exchange keyed by `<appId>.<topic>`; consumers
 * (provisioning workers, other apps) subscribe by routing key. The platform is
 * ignorant of the payload's meaning — the app owns the message shape.
 */
export interface AppEventPublisher {
  publish(topic: string, payload: unknown): Promise<void>
}

/**
 * A tenant Connection (a stored {@link Credential}) resolved to its DECRYPTED
 * secret + endpoint, returned by {@link AppRouteContext.resolveConnection}.
 *
 * SERVER-SIDE ONLY. The secret fields (`password` / `apiToken` / `certificate`)
 * are in the clear — use them to reach the connected system from a route, and
 * NEVER return them to the client or log them.
 */
export interface ResolvedConnection {
  id: string
  /** Human-readable connection label. */
  name: string
  /** API base URL / management endpoint (non-secret), or null. */
  endpoint: string | null
  /** Account / client id the credential authenticates as. */
  username: string
  /** Decrypted password (empty string for token-only connections). */
  password: string
  /** Decrypted API token, or null. */
  apiToken: string | null
  /** Decrypted client certificate, or null. */
  certificate: string | null
}

/**
 * Context passed to an app's server route module (the `server.entry`
 * declared in manifest.yaml). The platform mounts the module as a Fastify
 * plugin under `/api/apps/<appId>` with auth + app-enabled checks applied;
 * `hasPermission` returns a preHandler enforcing an app-scoped permission.
 */
export interface AppRouteContext {
  appId: string
  appDir: string
  manifest: AppManifest
  db: PlatformDatabaseClient
  /** Publish events/messages from this app to the platform message bus. */
  events: AppEventPublisher
  /**
   * Returns a Fastify preHandler enforcing an app-scoped permission.
   * Typed `any` so the SDK does not depend on Fastify's hook types —
   * pass it straight into a route's `preHandler` array.
   */
  hasPermission: (resource: string, action: string) => any
  /**
   * Resolve one of the tenant's Connections (a stored Credential, by id) to its
   * DECRYPTED secret + endpoint, so a route can reach the connected system
   * WITHOUT re-implementing the platform's credential decryption or querying
   * platform tables directly. Scoped to `customerId` (the tenant boundary);
   * returns null when no matching connection exists. The decrypted secret stays
   * server-side — never send it to the client. Pass a `credentialId` the app
   * obtained from its own connections list (e.g. the SDK `listCredentials`
   * helper), mirroring the platform's own "test connection" resolution.
   */
  resolveConnection: (customerId: string, credentialId: string) => Promise<ResolvedConnection | null>
}
