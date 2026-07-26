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
  const base = client.overridesPath()

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (e.existed && e.prior) {
      // Pre-existing before we managed it — remove our version and recreate the
      // original (there is no update API).
      if (e.id) {
        const del = await client.delete(`${base}/${e.id}`)
        if (!del.ok && del.status !== 404) {
          failures.push(`restore ${e.name}: ${cbErrorMessage(del)}`)
          continue
        }
      }
      const resp = await client.post(base, e.prior)
      if (!resp.ok) failures.push(`restore ${e.name}: ${cbErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed && e.id) {
      // We created this one — remove it.
      const del = await client.delete(`${base}/${e.id}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${e.name}: ${cbErrorMessage(del)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back reputation overrides: ${deleted} deleted, ${restored} restored` }
}
