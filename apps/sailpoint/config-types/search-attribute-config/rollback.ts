import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { RollbackEntry } from './deploy'

const BASE = '/v3/accounts/search-attribute-config'

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
      const ops = [
        { op: 'replace', path: '/displayName', value: e.prior.displayName },
        { op: 'replace', path: '/applicationAttributes', value: e.prior.applicationAttributes },
      ]
      const resp = await client.patch(`${BASE}/${encodeURIComponent(e.name)}`, ops)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${iscErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      const resp = await client.delete(`${BASE}/${encodeURIComponent(e.name)}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${iscErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back search attributes: ${deleted} deleted, ${restored} restored` }
}
