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
const UPDATE_MASK = 'description,allowedDataAccessLabels,deniedDataAccessLabels'

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
    if (!e.existed) {
      // We created this scope — remove it.
      const del = await client.request('DELETE', `${parent}/dataAccessScopes/${enc(e.name)}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${e.name}: ${secopsErrorMessage(del)}`)
      else deleted++
    } else if (e.prior) {
      // We updated this scope — restore its prior description and label sets.
      const resp = await client.request('PATCH', `${parent}/dataAccessScopes/${enc(e.name)}?updateMask=${UPDATE_MASK}`, {
        description: e.prior.description,
        allowedDataAccessLabels: e.prior.allowedRefs,
        deniedDataAccessLabels: e.prior.deniedRefs,
      })
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${secopsErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back data access scopes: ${deleted} deleted, ${restored} restored` }
}
