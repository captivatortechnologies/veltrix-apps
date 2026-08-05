import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/prismacloud'
import type { RollbackEntry } from './deploy'

const V2 = '/v2/user'
const V1 = '/user'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildPcClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (e.existed && e.prior) {
      const resp = await client.put(`${V2}/${encodeURIComponent(e.email)}`, {
        email: e.email,
        firstName: e.prior.firstName,
        lastName: e.prior.lastName,
        timeZone: e.prior.timeZone,
        defaultRoleId: e.prior.defaultRoleId,
        roleIds: e.prior.roleIds,
        accessKeysAllowed: e.prior.accessKeysAllowed,
      })
      if (!resp.ok && resp.status !== 404) {
        failures.push(`restore ${e.email}: ${pcErrorMessage(resp)}`)
        continue
      }
      const st = await client.patch(`${V1}/${encodeURIComponent(e.email)}/status/${e.prior.enabled}`)
      if (!st.ok && st.status !== 404) failures.push(`restore ${e.email} status: ${pcErrorMessage(st)}`)
      else restored++
    } else if (!e.existed) {
      // We created this one — remove it.
      const resp = await client.delete(`${V1}/${encodeURIComponent(e.email)}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.email}: ${pcErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back users: ${deleted} deleted, ${restored} restored` }
}
