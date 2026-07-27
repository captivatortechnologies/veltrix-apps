import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/prismacloud'
import type { RollbackEntry } from './deploy'

const COMPLIANCE = '/compliance'

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
      const body: Record<string, unknown> = {
        name: e.prior.name,
        requirementId: e.prior.requirementId,
        description: e.prior.description,
      }
      if (e.prior.viewOrder !== undefined) body.viewOrder = e.prior.viewOrder
      const resp = await client.put(`${COMPLIANCE}/requirement/${e.id}`, body)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.standardName}/${e.requirementId}: ${pcErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      // We created this one — remove it.
      const resp = await client.delete(`${COMPLIANCE}/requirement/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.standardName}/${e.requirementId}: ${pcErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back compliance requirements: ${deleted} deleted, ${restored} restored` }
}
