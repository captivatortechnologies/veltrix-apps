import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import type { RollbackEntry } from './deploy'

const BASE = '/groups'

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
  let refsRevoked = 0

  for (const e of entries) {
    if (!e.id) continue
    if (e.existed && e.prior) {
      // We updated this one — restore its prior managed fields.
      const resp = await client.patch(`${BASE}/${e.id}`, e.prior)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${graphErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      // We created this one — remove it (its owner/member references go with it).
      const resp = await client.delete(`${BASE}/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${graphErrorMessage(resp)}`)
      else deleted++
      continue
    }

    // The group itself survives rollback — revert only the owner/member
    // references THIS deploy added (existed:false). A reference the group
    // already had before this deploy is left untouched. "/$ref" is required —
    // see reconcileRefCollection.
    for (const o of e.owners ?? []) {
      if (o.existed) continue
      const resp = await client.delete(`${BASE}/${e.id}/owners/${o.id}/$ref`)
      if (!resp.ok && resp.status !== 404) failures.push(`revoke owner ${o.id} from ${e.name}: ${graphErrorMessage(resp)}`)
      else refsRevoked++
    }
    for (const m of e.members ?? []) {
      if (m.existed) continue
      const resp = await client.delete(`${BASE}/${e.id}/members/${m.id}/$ref`)
      if (!resp.ok && resp.status !== 404) failures.push(`revoke member ${m.id} from ${e.name}: ${graphErrorMessage(resp)}`)
      else refsRevoked++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return {
    success: true,
    message: `Rolled back groups: ${deleted} deleted, ${restored} restored, ${refsRevoked} owner/member reference(s) revoked`,
  }
}
