// ========================================================================
// React hooks for app developers
// These provide access to platform data and pipeline state
// ========================================================================

import { createContext, useContext } from 'react'
import type { Component, Credential, Tag, User, Customer } from '../types/platform'

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
}

export const AppContext = createContext<AppContextValue | null>(null)

/**
 * Access the app context in any app component.
 *
 * @example
 * ```tsx
 * import { useAppContext } from '@veltrix/app-sdk/hooks'
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
