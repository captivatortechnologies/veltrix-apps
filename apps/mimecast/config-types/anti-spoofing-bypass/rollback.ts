import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/mimecast'
import type { RollbackEntry } from './deploy'

const CREATE = '/api/policy/antispoofing-bypass/create-policy'
const DELETE = '/api/policy/antispoofing-bypass/delete-policy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildMimecastClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (e.existed && e.prior) {
      if (e.id) {
        const del = await client.request(DELETE, { id: e.id })
        if (!del.ok) {
          failures.push(`restore ${e.name}: ${mimecastErrorMessage(del)}`)
          continue
        }
      }
      const resp = await client.request(CREATE, e.prior)
      if (!resp.ok) failures.push(`restore ${e.name}: ${mimecastErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed && e.id) {
      const del = await client.request(DELETE, { id: e.id })
      if (!del.ok) failures.push(`delete ${e.name}: ${mimecastErrorMessage(del)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back anti-spoofing bypass policies: ${deleted} deleted, ${restored} restored` }
}
