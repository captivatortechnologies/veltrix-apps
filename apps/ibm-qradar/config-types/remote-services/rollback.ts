import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/qradar'
import type { RollbackEntry } from './deploy'

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
  let changed = false

  for (const e of entries) {
    if (typeof e.id !== 'number') continue
    if (!e.existed) {
      const resp = await client.request('DELETE', `/staged_config/remote_services/${e.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${e.name}: ${qradarErrorMessage(resp)}`)
      else { deleted++; changed = true }
    } else if (e.prior) {
      const resp = await client.request('POST', `/staged_config/remote_services/${e.id}`, { body: e.prior })
      if (!resp.ok) failures.push(`restore ${e.name}: ${qradarErrorMessage(resp)}`)
      else { restored++; changed = true }
    }
  }

  if (changed) {
    const dep = await client.deployStagedConfig('INCREMENTAL')
    if (!dep.ok) failures.push(`deploy: ${dep.message}`)
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back remote services: ${deleted} deleted, ${restored} restored` }
}
