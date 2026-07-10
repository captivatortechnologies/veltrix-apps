// ========================================================================
// Client runtime contract — how app client bundles talk to the host.
//
// App client code is packaged as a hermetic ESM bundle in which `react`,
// `react-dom`, `react/jsx-runtime`, and every `@veltrixsecops/app-sdk`
// subpath are compile-time shims that read the host-provided runtime from
// `globalThis.__VELTRIX_APP_RUNTIME__`. The platform installs that global
// (with ITS React instance, the shared AppContext, and an authenticated
// fetch) before dynamically importing any app bundle, so app components
// render inside the host React tree with working hooks and context.
//
// App authors: import from '@veltrixsecops/app-sdk/client' (and /hooks) —
// never bundle your own copy of react. Use `authFetch` for calls to your
// app's server routes (/api/apps/<app-id>/...): plain fetch() lacks the
// platform's Authorization header and will receive 401s.
// ========================================================================

import type { ComponentType, Context, LazyExoticComponent } from 'react'
import type { AppContextValue } from '../hooks/use-app-context'

export type { AppBrandingDeclaration } from '../types/manifest'

// Inventory — typed helpers over the platform's components API (deployment
// targets: servers, domains, IP/CIDR ranges). Framework-free; they use the
// `authFetch` exported below internally.
export {
  listInventory,
  addInventoryItem,
  updateInventoryItem,
  removeInventoryItem,
  resolveTool,
} from './inventory'
export type { Tool } from './inventory'
export type { InventoryItem, InventoryItemInput } from '../types/platform'

// Access Servers — typed helpers over the platform's access-servers API (ZTNA
// gateways) plus a reader over connectivity providers for the link picker.
// Framework-free; they use the `authFetch` exported below internally.
export {
  listAccessServers,
  addAccessServer,
  updateAccessServer,
  removeAccessServer,
  listConnectivityProviders,
} from './access-servers'
export type { AccessServer, AccessServerInput, ConnectivityProviderRef } from '../types/platform'

// Credentials — typed helpers over the platform's credentials API. Paired with
// a server (component) these form a "connection". Secrets are write-only:
// `listCredentials` returns redacted summaries only. Framework-free; they use
// the `authFetch` exported below internally.
export {
  listCredentials,
  createCredential,
  updateCredential,
  removeCredential,
} from './credentials'
export type { Credential, CredentialSummary, CredentialInput } from '../types/platform'

/** Name of the global the platform installs before loading app bundles. */
export const HOST_RUNTIME_GLOBAL = '__VELTRIX_APP_RUNTIME__'

/**
 * The runtime surface the platform exposes to app client bundles.
 * The react/reactDom/jsxRuntime members are the host's own module objects —
 * app bundles are compiled with shims that re-export them, guaranteeing a
 * single React instance per page.
 */
export interface VeltrixHostRuntime {
  /** The host's `react` module object. */
  react: unknown
  /** The host's `react-dom` module object. */
  reactDom: unknown
  /** The host's `react-dom/client` module object. */
  reactDomClient?: unknown
  /** The host's `react/jsx-runtime` module object. */
  jsxRuntime: unknown
  /** Shared app context — the host wraps app pages in its Provider. */
  AppContext: Context<AppContextValue | null>
  /** fetch() with the platform's Authorization header attached. */
  authFetch: (input: string, init?: RequestInit) => Promise<Response>
  /**
   * The SDK surface app bundles receive for `@veltrixsecops/app-sdk`,
   * `.../hooks`, and `.../client` imports (useAppContext, AppContext,
   * usePipelineStatus, authFetch, getHostRuntime, ...).
   */
  sdk: Record<string, unknown>
  /**
   * The platform's design-system components and hooks, host-owned so they
   * share the single host React instance. Keyed by the exact component/hook
   * names re-exported from `@veltrixsecops/app-sdk/ui` (Button, Input, Card,
   * DataTable, useToast, ...). Present only inside the platform.
   */
  ui?: Record<string, unknown>
}

/** Read the host runtime, or null outside the platform (tests, storybook). */
export function getHostRuntime(): VeltrixHostRuntime | null {
  const runtime = (globalThis as Record<string, unknown>)[HOST_RUNTIME_GLOBAL]
  return (runtime as VeltrixHostRuntime) ?? null
}

/** Read the host runtime, throwing a diagnosable error when absent. */
export function requireHostRuntime(): VeltrixHostRuntime {
  const runtime = getHostRuntime()
  if (!runtime) {
    throw new Error(
      'Veltrix host runtime not found — app client bundles only run inside the ' +
        `Veltrix platform (missing globalThis.${HOST_RUNTIME_GLOBAL})`,
    )
  }
  return runtime
}

/**
 * fetch() that carries the platform's Authorization header. Required for an
 * app page to call its own server routes (/api/apps/<app-id>/...), which are
 * bearer-token protected. Falls back to plain fetch outside the platform.
 */
export function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const runtime = getHostRuntime()
  if (runtime) return runtime.authFetch(input, init)
  return fetch(input, init)
}

/** A sidebar entry contributed by the app's client entry module. */
export interface AppSidebarItem {
  path: string
  label: string
  icon?: string
}

/**
 * Shape of the default export of an app's `client/index.tsx`.
 * `pages` keys must match `manifest.client.pages[].component`.
 */
export interface AppClientModule {
  id: string
  pages: Record<string, ComponentType | LazyExoticComponent<ComponentType>>
  sidebarItems?: AppSidebarItem[]
}
