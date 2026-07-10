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
  /** Component type tags (e.g. ["server"]) that classify the target. */
  type?: string[]
  /** DNS names this target is reachable at. */
  domains?: string[]
  /** IP addresses or CIDR ranges this target covers. */
  ipRanges?: string[]
  /** Platform tags attached to this target. */
  tags?: { id: string; name: string }[]
  /** Assigned connectivity provider, or null when none is configured. */
  connectivityProviderId?: string | null
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
  type?: string[]
  domains?: string[]
  ipRanges?: string[]
  /** IDs of existing platform tags to attach to the target. */
  tagIds?: string[]
  /** The tool this target belongs to. Required by the platform on create. */
  toolId?: string
  connectivityProviderId?: string | null
}

export interface Credential {
  id: string
  name: string
  username: string
  password: string
  apiToken: string | null
  certificate: string | null
  toolId: string
  customerId: string
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
  /**
   * Returns a Fastify preHandler enforcing an app-scoped permission.
   * Typed `any` so the SDK does not depend on Fastify's hook types —
   * pass it straight into a route's `preHandler` array.
   */
  hasPermission: (resource: string, action: string) => any
}
