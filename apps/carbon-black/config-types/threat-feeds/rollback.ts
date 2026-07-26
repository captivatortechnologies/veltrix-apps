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
    if (!e.id) continue
    if (e.existed && e.prior) {
      const info = await client.put(`${feedsPath}/${e.id}/feedinfo`, e.prior.feedinfo)
      if (!info.ok && info.status !== 404) failures.push(`restore ${e.name}: ${cbErrorMessage(info)}`)
      const reps = await client.post(`${feedsPath}/${e.id}/reports`, { reports: e.prior.reports })
      if (!reps.ok && reps.status !== 404) failures.push(`restore ${e.name}: reports: ${cbErrorMessage(reps)}`)
      if ((info.ok || info.status === 404) && (reps.ok || reps.status === 404)) restored++
    } else if (!e.existed) {
      const resp = await client.delete(`${feedsPath}/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${cbErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back threat feeds: ${deleted} deleted, ${restored} restored` }
}
