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
