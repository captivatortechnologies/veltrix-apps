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
  const base = client.assetGroupsPath()

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.id) continue
    if (e.existed && e.prior) {
      const body: Record<string, unknown> = {
        name: e.prior.name,
        description: e.prior.description,
        member_type: e.prior.member_type,
      }
      if (e.prior.query) body.query = e.prior.query
      if (e.prior.policy_id !== null && e.prior.policy_id !== undefined) body.policy_id = e.prior.policy_id
      const resp = await client.put(`${base}/${e.id}`, body)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${cbErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      const del = await client.delete(`${base}/${e.id}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${e.name}: ${cbErrorMessage(del)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back asset groups: ${deleted} deleted, ${restored} restored` }
}
