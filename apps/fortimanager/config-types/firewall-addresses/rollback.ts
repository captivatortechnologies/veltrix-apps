import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  addressUrl,
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace, type RollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildFmgClient(cred, settings)
  const url = addressUrl(settings.adom)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  if (settings.workspaceMode) {
    const lock = await client.lock(settings.adom)
    if (!lock.ok) {
      await client.logout()
      return { success: false, message: `Failed to lock ADOM "${settings.adom}": ${fmgErrorMessage(lock)}` }
    }
  }

  try {
    for (const e of entries) {
      if (e.existed && e.prior) {
        // We updated this one — restore its prior body (set = upsert).
        const resp = await client.set(url, e.prior)
        if (!resp.ok) failures.push(`restore ${e.name}: ${fmgErrorMessage(resp)}`)
        else restored++
      } else if (!e.existed) {
        // We created this one — remove it.
        const resp = await client.delete(url, ['name', '==', e.name])
        if (!resp.ok) failures.push(`delete ${e.name}: ${fmgErrorMessage(resp)}`)
        else deleted++
      }
    }
    if (settings.workspaceMode) {
      await finishWorkspace(client, settings.adom, failures)
    }
  } finally {
    await client.logout()
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back firewall addresses: ${deleted} deleted, ${restored} restored` }
}
