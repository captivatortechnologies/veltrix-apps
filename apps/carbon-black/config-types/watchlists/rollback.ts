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
  const watchlistsPath = `/threathunter/watchlistmgr/v3/orgs/${cred.orgKey}/watchlists`

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.watchlistId) continue
    if (e.existed && e.prior) {
      const resp = await client.put(`${watchlistsPath}/${e.watchlistId}`, e.prior)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${cbErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      const resp = await client.delete(`${watchlistsPath}/${e.watchlistId}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${cbErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back watchlists: ${deleted} deleted, ${restored} restored` }
}
