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
    if (!e.ruleName_live) continue
    if (!e.existed) {
      // We created this rule — remove it (force drops its revisions/history too).
      const del = await client.request('DELETE', `${parent}/rules/${enc(e.ruleName_live)}?force=true`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${e.ruleName}: ${secopsErrorMessage(del)}`)
      else deleted++
    } else if (e.priorText !== undefined) {
      // We updated this rule — restore the prior text as a new revision.
      const resp = await client.request('PATCH', `${parent}/rules/${enc(e.ruleName_live)}?updateMask=text`, { text: e.priorText })
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.ruleName}: ${secopsErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back detection rules: ${deleted} deleted, ${restored} restored` }
}
