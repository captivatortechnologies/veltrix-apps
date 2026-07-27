import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/duo'
import type { RollbackEntry } from './deploy'

const BASE = '/admin/v1/administrative_units'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.adminUnitId) continue
    if (e.existed && e.prior) {
      // We updated this one — restore its prior scalar fields.
      const resp = await client.post(`${BASE}/${e.adminUnitId}`, {
        name: e.prior.name,
        description: e.prior.description,
        restrict_by_groups: e.prior.restrictByGroups ? 'true' : 'false',
        restrict_by_integrations: e.prior.restrictByIntegrations ? 'true' : 'false',
      })
      if (!resp.ok) failures.push(`restore ${e.name}: ${duoErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      // We created this one — remove it.
      const resp = await client.delete(`${BASE}/${e.adminUnitId}`)
      if (!resp.ok) failures.push(`delete ${e.name}: ${duoErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back administrative units: ${deleted} deleted, ${restored} restored` }
}
