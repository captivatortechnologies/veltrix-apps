import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { bulkReplaceBody, type RollbackEntry } from './deploy'

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
      // We created this table — remove it (force drops its rows too).
      const del = await client.request('DELETE', `${parent}/dataTables/${enc(e.name)}?force=true`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${e.name}: ${secopsErrorMessage(del)}`)
      else deleted++
    } else {
      // We replaced its rows — restore the prior set.
      const rows = e.prior?.rows ?? []
      const resp = await client.request('POST', `${parent}/dataTables/${enc(e.name)}/dataTableRows:bulkReplace`, bulkReplaceBody(rows))
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${secopsErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back data tables: ${deleted} deleted, ${restored} restored` }
}
