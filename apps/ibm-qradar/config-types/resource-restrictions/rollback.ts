import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/qradar'
import { bodyFromState, type RollbackEntry } from './deploy'

const PATH = '/config/resource_restrictions'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.id) continue
    if (!e.existed) {
      const resp = await client.request('DELETE', `${PATH}/${e.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${e.targetType} "${e.targetName}": ${qradarErrorMessage(resp)}`)
      else deleted++
    } else if (e.prior) {
      const resp = await client.request('PUT', `${PATH}/${e.id}`, { body: bodyFromState(e.prior) })
      if (!resp.ok) failures.push(`restore ${e.targetType} "${e.targetName}": ${qradarErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back resource restrictions: ${deleted} deleted, ${restored} restored` }
}
