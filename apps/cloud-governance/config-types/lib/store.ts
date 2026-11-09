import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'

export interface Store {
  db: PlatformDatabaseClient
  customerId: string
}

export const STORE_UNAVAILABLE =
  'The platform did not provide the governance store to this handler (ctx.db is missing). Upgrade the platform to a version that injects the app database into pipeline handlers.'

/**
 * Pipeline handler contexts do not carry the app database today; the seam is
 * `ctx.db` (an app-scoped PlatformDatabaseClient) and every handler degrades
 * explicitly when it is absent instead of pretending to have acted.
 */
export function resolveStore(ctx: { customerId: string }): Store | null {
  const db = (ctx as { db?: PlatformDatabaseClient }).db
  if (!db || typeof db.$queryRawUnsafe !== 'function') return null
  return { db, customerId: ctx.customerId }
}
