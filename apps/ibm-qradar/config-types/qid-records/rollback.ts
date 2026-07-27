import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/qradar'
import type { RollbackEntry } from './deploy'

const QID_PATH = '/data_classification/qid_records'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let createdCount = 0

  for (const e of entries) {
    if (!e.existed) {
      // No delete endpoint — a record this app created cannot be removed.
      createdCount++
      continue
    }
    if (typeof e.id === 'number' && e.prior) {
      const body: Record<string, unknown> = { name: e.prior.name, description: e.prior.description }
      if (e.prior.low_level_category_id !== undefined) body.low_level_category_id = e.prior.low_level_category_id
      if (e.prior.severity !== undefined) body.severity = e.prior.severity
      const resp = await client.request('POST', `${QID_PATH}/${e.id}`, { body })
      if (!resp.ok) failures.push(`restore ${e.name}: ${qradarErrorMessage(resp)}`)
      else restored++
    }
    createdCount += e.mappings.filter((m) => !m.existed).length
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  const suffix = createdCount > 0 ? `; ${createdCount} created record(s)/mapping(s) cannot be removed (append-only)` : ''
  return { success: true, message: `Rolled back QID records: ${restored} restored${suffix}` }
}
