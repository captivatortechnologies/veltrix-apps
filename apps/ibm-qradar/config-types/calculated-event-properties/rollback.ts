import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/qradar'
import type { RollbackEntry } from './deploy'

const PATH = '/config/event_sources/custom_properties/calculated_properties'

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
    if (typeof e.id !== 'number') continue
    if (!e.existed) {
      const resp = await client.request('DELETE', `${PATH}/${e.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${e.name}: ${qradarErrorMessage(resp)}`)
      else deleted++
    } else if (e.prior) {
      const resp = await client.request('POST', `${PATH}/${e.id}`, { body: e.prior })
      if (!resp.ok) failures.push(`restore ${e.name}: ${qradarErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back calculated properties: ${deleted} deleted, ${restored} restored` }
}
