import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { RollbackEntry } from './deploy'

const BASE = '/beta/verified-from-addresses'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let deleted = 0

  for (const e of entries) {
    // Only app-created addresses are removed; pre-existing ones are left as-is.
    if (!e.existed && e.id) {
      const resp = await client.delete(`${BASE}/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.email}: ${iscErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back verified from-addresses: ${deleted} deleted` }
}
