import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { patchBody, type RollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let emptied = 0

  for (const e of entries) {
    // Reference lists can't be deleted, so both cases are a PATCH: restore the
    // prior entries/description (existed) or empty the list we created.
    const prior = e.prior ?? { description: '', entries: [] }
    const target = e.existed ? prior : { description: '', entries: [] }
    const resp = await client.request(
      'PATCH',
      `${parent}/referenceLists/${encodeURIComponent(e.name)}?updateMask=entries,description`,
      patchBody(target.description, target.entries)
    )
    if (!resp.ok && resp.status !== 404) failures.push(`rollback ${e.name}: ${secopsErrorMessage(resp)}`)
    else if (e.existed) restored++
    else emptied++
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back reference lists: ${restored} restored, ${emptied} emptied` }
}
