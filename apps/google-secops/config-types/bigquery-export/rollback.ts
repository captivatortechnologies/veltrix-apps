import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { BQ_SOURCES } from './validate'
import { type RollbackEntry } from './deploy'

const UPDATE_MASK = BQ_SOURCES.map((s) => s.settings).join(',')

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entry = Array.isArray(data?.entries) ? data.entries[0] : undefined
  if (!entry?.prior) return { success: true, message: 'Nothing to roll back for BigQuery export' }

  const body: Record<string, unknown> = {}
  for (const s of BQ_SOURCES) {
    const setting = entry.prior[s.key] ?? { enabled: false, retentionDays: 0 }
    body[s.settings] = { enabled: setting.enabled, retentionDays: setting.retentionDays }
  }

  // Singleton — never created/deleted; restore the prior per-source settings.
  const resp = await client.request('PATCH', `${parent}/bigQueryExport?updateMask=${UPDATE_MASK}`, body)
  if (!resp.ok && resp.status !== 404) {
    return { success: false, message: `Rollback had errors: ${secopsErrorMessage(resp)}` }
  }
  return { success: true, message: 'Rolled back BigQuery export settings' }
}
