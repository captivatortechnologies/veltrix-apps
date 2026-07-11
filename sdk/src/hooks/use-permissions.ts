import { useAppContext } from './use-app-context'
import type { AppPermissionsApi } from '../types/platform'

/**
 * Permission checks for THIS app (RBAC/IdP hardening, Wave C4). `has()`
 * without an explicit `opts.appId` checks the app's own declared resources
 * by default — pass `{ appId: null }` for a platform resource, or another
 * app's id to check a different app.
 *
 * @example
 * ```tsx
 * import { usePermissions } from '@veltrixsecops/app-sdk/hooks'
 *
 * function IndexesPage() {
 *   const { has } = usePermissions()
 *   if (!has('indexes', 'write')) {
 *     return <p>You don't have permission to edit indexes.</p>
 *   }
 *   // ...
 * }
 * ```
 */
export function usePermissions(): AppPermissionsApi {
  return useAppContext().permissions
}
