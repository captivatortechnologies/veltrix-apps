import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/duo'
import type { RollbackEntry } from './deploy'

const BASE = '/admin/v1/integrations'

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
    if (!e.integrationKey) continue
    if (e.existed && e.prior) {
      const resp = await client.post(`${BASE}/${e.integrationKey}`, { name: e.prior.name })
      if (!resp.ok) failures.push(`restore ${e.name}: ${duoErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      const resp = await client.delete(`${BASE}/${e.integrationKey}`)
      if (!resp.ok) failures.push(`delete ${e.name}: ${duoErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back integrations: ${deleted} deleted, ${restored} restored` }
}
