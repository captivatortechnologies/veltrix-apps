import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/mimecast'
import type { RollbackEntry } from './deploy'

const DELETE = '/api/policy/address-alteration/delete-definition'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildMimecastClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let deleted = 0

  // A definition is its own identity tuple — the app never modifies an adopted
  // one, so rollback only removes the definitions this app created.
  for (const e of entries) {
    if (!e.existed && e.id) {
      const del = await client.request(DELETE, { id: e.id })
      if (!del.ok) failures.push(`delete ${e.name}: ${mimecastErrorMessage(del)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back address alteration definitions: ${deleted} deleted` }
}
