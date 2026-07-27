import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { REGISTRY, revertConfig, type RollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0

  for (const e of entries) {
    const reg = REGISTRY[e.setting]
    if (!reg) continue
    const res = await revertConfig(client, reg, e.prior)
    if (!res.ok) failures.push(`restore ${e.setting}: ${res.error}`)
    else restored++
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back tenant settings: ${restored} restored` }
}
