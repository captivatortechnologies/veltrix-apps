import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { SP_BASE } from './validate'
import type { RollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0
  let ownersRevoked = 0

  for (const e of entries) {
    if (!e.id) continue
    if (e.existed && e.prior) {
      // We updated a pre-existing SP — restore its prior managed fields (never delete it).
      const resp = await client.patch(`${SP_BASE}/${e.id}`, e.prior)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.appId}: ${graphErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      // We created this SP — remove it (its owner references go with it).
      const resp = await client.delete(`${SP_BASE}/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.appId}: ${graphErrorMessage(resp)}`)
      else deleted++
      continue
    }

    // The SP itself survives rollback — revert only the ownership THIS
    // deploy added (existed:false). An owner the SP already had before this
    // deploy is left untouched.
    for (const o of e.owners ?? []) {
      if (o.existed) continue
      const resp = await client.delete(`${SP_BASE}/${e.id}/owners/${o.id}/$ref`)
      if (!resp.ok && resp.status !== 404) failures.push(`revoke owner ${o.id} from ${e.appId}: ${graphErrorMessage(resp)}`)
      else ownersRevoked++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return {
    success: true,
    message: `Rolled back service principals: ${deleted} deleted, ${restored} restored, ${ownersRevoked} owner(s) revoked`,
  }
}
