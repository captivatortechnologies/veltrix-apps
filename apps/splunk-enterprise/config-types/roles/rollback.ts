import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, splunkRequest, postForm } from '../../lib/splunkApi'

interface RoleRollbackData {
  previousState?: Array<Record<string, unknown>>
  createdRoles?: string[]
}

/** Scalar settings restored directly from the snapshot. */
const SCALAR_RESTORE_KEYS = [
  'srchFilter', 'srchDiskQuota', 'srchJobsQuota', 'rtSrchJobsQuota', 'srchTimeWin', 'defaultApp',
] as const

/** Multi-value settings restored with repeated form parameters. */
const ARRAY_RESTORE_KEYS = [
  'capabilities', 'imported_roles', 'srchIndexesAllowed', 'srchIndexesDefault',
] as const

/**
 * Rollback role configuration:
 *  - restores previous settings of roles that existed before the deploy
 *  - deletes roles the deploy created
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, rollbackData } = ctx

  if (!credential || !connectivity) {
    return { success: false, message: 'Missing credential or connectivity for rollback' }
  }

  const data = (rollbackData as RoleRollbackData) || {}
  const previousState = data.previousState ?? []
  const createdRoles = data.createdRoles ?? []

  if (previousState.length === 0 && createdRoles.length === 0) {
    return { success: false, message: 'No previous state available for role rollback' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  try {
    for (const roleState of previousState) {
      const name = roleState.name as string
      const payload: Record<string, string | string[] | undefined> = {}

      for (const key of SCALAR_RESTORE_KEYS) {
        if (roleState[key] !== undefined && roleState[key] !== null) {
          payload[key] = String(roleState[key])
        }
      }
      for (const key of ARRAY_RESTORE_KEYS) {
        const value = roleState[key]
        if (Array.isArray(value) && value.length > 0) {
          payload[key] = value.map(String)
        }
      }
      if (Object.keys(payload).length === 0) continue

      await postForm(baseUrl, auth, `/services/authorization/roles/${encodeURIComponent(name)}`, payload)
    }

    for (const name of createdRoles) {
      await splunkRequest(`${baseUrl}/services/authorization/roles/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: auth,
      })
    }

    const actions: string[] = []
    if (previousState.length > 0) actions.push(`restored ${previousState.length} role(s)`)
    if (createdRoles.length > 0) actions.push(`deleted ${createdRoles.length} created role(s)`)
    return { success: true, message: `Rollback complete: ${actions.join(', ')}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
