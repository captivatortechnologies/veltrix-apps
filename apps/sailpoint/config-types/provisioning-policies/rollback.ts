import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { RollbackEntry } from './deploy'

const SOURCES = '/v3/sources'
const childBase = (sourceId: string): string => `${SOURCES}/${sourceId}/provisioning-policies`

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (e.existed && e.prior) {
      const resp = await client.put(`${childBase(e.sourceId)}/${e.usageType}`, e.prior)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.usageType}: ${iscErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      const resp = await client.delete(`${childBase(e.sourceId)}/${e.usageType}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.usageType}: ${iscErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back provisioning policies: ${deleted} deleted, ${restored} restored` }
}
