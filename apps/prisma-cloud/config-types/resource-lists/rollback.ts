import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/prismacloud'
import type { RollbackEntry } from './deploy'

const BASE = '/v1/resource_list'

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
    if (!e.id) continue
    if (e.existed && e.prior) {
      // We updated this one — restore its prior fields.
      const resp = await client.put(`${BASE}/${e.id}`, {
        name: e.prior.name,
        description: e.prior.description,
        resourceListType: e.prior.resourceListType,
        members: e.prior.members,
      })
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${pcErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      // We created this one — remove it.
      const resp = await client.delete(`${BASE}/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${pcErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back resource lists: ${deleted} deleted, ${restored} restored` }
}
