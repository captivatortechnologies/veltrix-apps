import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMimecastClient, readMimecastSettings, resolveMimecastCredential, v1ErrorMessage, MISSING_CREDENTIAL_MESSAGE } from '../../lib/mimecast'
import type { RollbackEntry } from './deploy'

const LIST = '/policy-management/cloud-gateway/v1/greylisting/policies'
const ITEM = (id: string): string => `${LIST}/${id}`

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
    if (e.existed && e.prior && e.id) {
      const patched = await client.requestV1('PATCH', ITEM(e.id), { body: e.prior })
      if (!patched.ok) failures.push(`restore ${e.name}: ${patched.error ?? v1ErrorMessage(patched.body, patched.status)}`)
      else restored++
    } else if (!e.existed && e.id) {
      const del = await client.requestV1('DELETE', ITEM(e.id))
      if (!del.ok) failures.push(`delete ${e.name}: ${del.error ?? v1ErrorMessage(del.body, del.status)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back greylisting policies: ${deleted} deleted, ${restored} restored` }
}
