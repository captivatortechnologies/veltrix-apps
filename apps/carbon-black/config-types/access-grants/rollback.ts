import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/carbonblack'
import type { RollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildCbClient(cred, settings)
  const grantsBase = client.grantsPath()
  const orgRef = client.orgRefUrn()

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.principalUrn) continue
    if (!e.existed) {
      // This app created the grant from nothing — undo the create entirely.
      const del = await client.delete(`${grantsBase}/${encodeURIComponent(e.principalUrn)}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${e.principalEmail}: ${cbErrorMessage(del)}`)
      else deleted++
    } else {
      // A grant already existed — restore its exact pre-deploy roles snapshot.
      const put = await client.put(`${grantsBase}/${encodeURIComponent(e.principalUrn)}`, {
        principal: e.principalUrn,
        principal_name: e.principalEmail,
        org_ref: orgRef,
        roles: e.priorRoles,
      })
      if (!put.ok && put.status !== 404) failures.push(`restore ${e.principalEmail}: ${cbErrorMessage(put)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back access grants: ${deleted} deleted, ${restored} restored` }
}
