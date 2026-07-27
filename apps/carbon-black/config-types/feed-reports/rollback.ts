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
  const feedsPath = `/threathunter/feedmgr/v2/orgs/${cred.orgKey}/feeds`

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.reportId || !e.feedId) continue
    const url = `${feedsPath}/${e.feedId}/reports/${e.reportId}`
    if (e.existed && e.prior) {
      const resp = await client.put(url, e.prior)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.title}: ${cbErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      const resp = await client.delete(url)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.title}: ${cbErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back feed reports: ${deleted} deleted, ${restored} restored` }
}
