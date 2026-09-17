import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace } from '../firewall-addresses/deploy'
import { internetServiceCustomGroupUrl, type RollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildFmgClient(cred, settings)
  const url = internetServiceCustomGroupUrl(settings.adom)

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

  // Cleared to true only when the work above ran to the end, so the
  // finally below can tell a completed run from an aborted one.
  let completed = false
  try {
    for (const e of entries) {
      if (e.existed && e.prior) {
        const resp = await client.set(url, e.prior)
        if (!resp.ok) failures.push(`restore ${e.name}: ${fmgErrorMessage(resp)}`)
        else restored++
      } else if (!e.existed) {
        const resp = await client.delete(url, ['name', '==', e.name])
        if (!resp.ok) failures.push(`delete ${e.name}: ${fmgErrorMessage(resp)}`)
        else deleted++
      }
    }
    completed = true
  } finally {
    // Release the ADOM lock even if the work above threw. A workspace-mode
    // ADOM left locked blocks every other FortiManager administrator until
    // someone clears it by hand, and the deploy that caused it reads green.
    //
    // `commit` is false on the throw path: the ADOM then holds partially
    // written changes, and unlocking without committing is what discards them.
    if (settings.workspaceMode) {
      await finishWorkspace(client, settings.adom, failures, {
        commit: completed && failures.length === 0,
      })
    }
    await client.logout()
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back custom internet service groups: ${deleted} deleted, ${restored} restored` }
}
