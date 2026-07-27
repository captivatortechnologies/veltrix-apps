import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { type RollbackEntry } from './deploy'

const enc = encodeURIComponent
const UPDATE_MASK = 'displayName,description,processors'

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
  let deleted = 0

  for (const e of entries) {
    if (!e.existed) {
      // We created this pipeline — remove it.
      const del = await client.request('DELETE', `${parent}/logProcessingPipelines/${enc(e.id)}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${e.id}: ${secopsErrorMessage(del)}`)
      else deleted++
    } else if (e.prior) {
      // We updated this pipeline — restore its prior definition.
      const resp = await client.request('PATCH', `${parent}/logProcessingPipelines/${enc(e.id)}?updateMask=${UPDATE_MASK}`, {
        displayName: e.prior.displayName,
        description: e.prior.description,
        processors: e.prior.processors ?? [],
      })
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.id}: ${secopsErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back log processing pipelines: ${deleted} deleted, ${restored} restored` }
}
