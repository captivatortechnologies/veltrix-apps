import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { RollbackEntry } from './deploy'

const BASE = '/beta/notification-templates'
const BULK_DELETE = '/beta/notification-templates/bulk-delete'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0

  const toDelete: Array<{ key: string; medium: string; locale: string }> = []
  for (const e of entries) {
    if (e.existed && e.prior) {
      const resp = await client.post(BASE, e.prior)
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.key}: ${iscErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      toDelete.push({ key: e.key, medium: e.medium, locale: e.locale })
    }
  }

  let deleted = 0
  if (toDelete.length > 0) {
    const resp = await client.post(BULK_DELETE, toDelete)
    if (!resp.ok && resp.status !== 404) failures.push(`bulk-delete: ${iscErrorMessage(resp)}`)
    else deleted = toDelete.length
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back notification templates: ${deleted} deleted, ${restored} restored` }
}
