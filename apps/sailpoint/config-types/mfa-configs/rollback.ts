import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { RollbackEntry } from './deploy'

const deletePath = (method: string): string => `/v3/mfa/${method}/config/delete`

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let disabled = 0
  let kept = 0

  for (const e of entries) {
    // Only disable a method the app enabled that was previously disabled — a
    // pre-enabled method's prior secret cannot be restored, so it is left as-is.
    if (!e.priorEnabled) {
      const resp = await client.delete(deletePath(e.method))
      if (!resp.ok && resp.status !== 404) failures.push(`disable ${e.method}: ${iscErrorMessage(resp)}`)
      else disabled++
    } else {
      kept++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back MFA configs: ${disabled} disabled, ${kept} left (pre-existing)` }
}
