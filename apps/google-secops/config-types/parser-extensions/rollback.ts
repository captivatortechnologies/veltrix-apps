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
  let deleted = 0

  for (const e of entries) {
    // Extensions are additive — undo a version this deploy created by deleting it,
    // reverting the log type to its base parser.
    if (!e.changed || !e.extensionId) continue
    const del = await client.request('DELETE', `${parent}/logTypes/${enc(e.logType)}/parserExtensions/${enc(e.extensionId)}`)
    if (!del.ok && del.status !== 404) failures.push(`delete ${e.logType} extension: ${secopsErrorMessage(del)}`)
    else deleted++
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back parser extensions: ${deleted} deleted` }
}
