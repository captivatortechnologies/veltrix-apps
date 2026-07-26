import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { applyPending, type RollbackEntry } from './deploy'

const BASE = '/policy/urllist'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0
  let changed = false

  for (const e of entries) {
    if (!e.id) continue
    if (e.existed && e.prior) {
      // We updated this one — restore its prior name/urls/type.
      const resp = await client.put(`${BASE}/${e.id}`, { name: e.prior.name, data: { urls: e.prior.urls, type: e.prior.type } })
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${netskopeErrorMessage(resp)}`)
      else {
        restored++
        changed = true
      }
    } else if (!e.existed) {
      // We created this one — remove it.
      const resp = await client.delete(`${BASE}/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${netskopeErrorMessage(resp)}`)
      else {
        deleted++
        changed = true
      }
    }
  }

  if (changed) await applyPending(client, failures)

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back URL lists: ${deleted} deleted, ${restored} restored` }
}
