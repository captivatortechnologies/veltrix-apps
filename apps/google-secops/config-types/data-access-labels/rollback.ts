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
      // We created this label — remove it.
      const del = await client.request('DELETE', `${parent}/dataAccessLabels/${enc(e.name)}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${e.name}: ${secopsErrorMessage(del)}`)
      else deleted++
    } else if (e.prior) {
      // We updated this label — restore its prior definition and description.
      const resp = await client.request(
        'PATCH',
        `${parent}/dataAccessLabels/${enc(e.name)}?updateMask=udmQuery,description`,
        { udmQuery: e.prior.udmQuery, description: e.prior.description }
      )
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${secopsErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back data access labels: ${deleted} deleted, ${restored} restored` }
}
