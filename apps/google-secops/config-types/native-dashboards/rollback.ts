import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { type RollbackEntry } from './deploy'

const enc = encodeURIComponent
const UPDATE_MASK = 'displayName,description,access,dashboardUserData.isPinned,definition.filters'
const DASHBOARD_TYPE = 'CUSTOM'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.dashboardId) continue
    if (!e.existed) {
      // We created this dashboard — remove it.
      const del = await client.request('DELETE', `${parent}/nativeDashboards/${enc(e.dashboardId)}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${e.displayName}: ${secopsErrorMessage(del)}`)
      else deleted++
    } else if (e.prior) {
      // We updated this dashboard — restore its prior shell + filters.
      const resp = await client.request('PATCH', `${parent}/nativeDashboards/${enc(e.dashboardId)}?updateMask=${UPDATE_MASK}`, {
        displayName: e.prior.displayName,
        description: e.prior.description,
        access: e.prior.access,
        type: DASHBOARD_TYPE,
        dashboardUserData: { isPinned: e.prior.isPinned },
        definition: { filters: e.prior.filters },
      })
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.displayName}: ${secopsErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back native dashboards: ${deleted} deleted, ${restored} restored` }
}
