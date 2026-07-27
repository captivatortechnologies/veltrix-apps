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
  let reverted = 0

  for (const e of entries) {
    // Only versions this deploy created are undone: re-activate the prior parser,
    // then delete the version we created.
    if (!e.changed || !e.createdParserId) continue
    if (e.priorActiveParserId) {
      await client.request('POST', `${parent}/logTypes/${enc(e.logType)}/parsers/${enc(e.priorActiveParserId)}:activate`, {})
    }
    const del = await client.request('DELETE', `${parent}/logTypes/${enc(e.logType)}/parsers/${enc(e.createdParserId)}`)
    if (!del.ok && del.status !== 404) failures.push(`delete ${e.logType} parser: ${secopsErrorMessage(del)}`)
    else reverted++
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back parsers: ${reverted} version(s) reverted` }
}
