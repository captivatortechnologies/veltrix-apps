// ========================================================================
// React hooks for app developers
// These provide access to platform data and pipeline state
// ========================================================================

import { createContext, useContext, type Context } from 'react'
import type { Component, Credential, Tag, User, Customer, AppPermissionsApi } from '../types/platform'
import type { AppBrandingDeclaration } from '../types/manifest'

export interface AppContextValue {
  appId: string
  customerId: string
  user: User | null
  customer: Customer | null

  // Platform data accessors
  getComponents: () => Promise<Component[]>
  getCredentials: () => Promise<Credential[]>
  getTags: () => Promise<Tag[]>

  // App settings
  settings: Record<string, unknown>

  /** The app's manifest branding, resolved by the platform (null when unset). */
  branding?: AppBrandingDeclaration | null

  /**
   * Permission checks for THIS app (RBAC/IdP hardening, Wave C4). `has()`
   * without an explicit `opts.appId` checks the app's OWN declared
   * resources by default. Prefer the `usePermissions()` hook
   * (`@veltrixsecops/app-sdk/hooks`) over reaching into this directly.
   */
  permissions: AppPermissionsApi
}

// Anchor the context on the host runtime when running inside the platform,
// so a bundle that inlined its own SDK copy still shares the host's context
// (two createContext objects never match, even with identical shapes).
const hostContext = (
  (globalThis as Record<string, unknown>).__VELTRIX_APP_RUNTIME__ as
    | { AppContext?: Context<AppContextValue | null> }
    | undefined
)?.AppContext

export const AppContext: Context<AppContextValue | null> =
  hostContext ?? createContext<AppContextValue | null>(null)

/**
 * Access the app context in any app component.
 *
 * @example
 * ```tsx
 * import { useAppContext } from '@veltrixsecops/app-sdk/hooks'
 *
 * function MyComponent() {
 *   const { appId, settings, getComponents } = useAppContext()
 *   // ...
 * }
 * ```
 */
export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) {
    throw new Error('useAppContext must be used within an AppContextProvider')
  }
  return ctx
}
