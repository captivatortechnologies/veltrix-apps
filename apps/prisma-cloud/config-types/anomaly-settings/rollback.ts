import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/prismacloud'
import type { RollbackEntry } from './deploy'

const BASE = '/anomalies/settings'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildPcClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0

  for (const e of entries) {
    const resp = await client.post(`${BASE}/${encodeURIComponent(e.policyId)}`, {
      alertDisposition: e.prior.alertDisposition,
      trainingModelThreshold: e.prior.trainingModelThreshold,
    })
    if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.policyId}: ${pcErrorMessage(resp)}`)
    else restored++
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Restored ${restored} anomaly setting(s)` }
}
