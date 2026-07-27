import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { BQ_SOURCES, extractBigQueryExportSpec, type BigQueryExportSpec, type LiveBigQueryExport } from './validate'

// BigQuery Export is a singleton — never created or deleted, only patched. The
// single entry captures the prior per-source settings so rollback can restore them.
export interface RollbackEntry {
  existed: boolean
  prior?: Record<string, { enabled: boolean; retentionDays: number }>
}

const UPDATE_MASK = BQ_SOURCES.map((s) => s.settings).join(',')

export function exportBody(spec: BigQueryExportSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const s of BQ_SOURCES) {
    const setting = spec.sources[s.key]
    body[s.settings] = { enabled: setting.enabled, retentionDays: setting.retentionDays }
  }
  return body
}

function readLiveSources(live: LiveBigQueryExport): Record<string, { enabled: boolean; retentionDays: number }> {
  const out: Record<string, { enabled: boolean; retentionDays: number }> = {}
  for (const s of BQ_SOURCES) {
    const settings = (live as Record<string, { enabled?: boolean; retentionDays?: number } | undefined>)[s.settings]
    out[s.key] = { enabled: settings?.enabled ?? false, retentionDays: settings?.retentionDays ?? 0 }
  }
  return out
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const spec = extractBigQueryExportSpec(ctx.canvas)
  if (!spec) return { success: true, message: 'No BigQuery export settings declared', rollbackData: { entries: [] } }

  const getRes = await client.request('GET', `${parent}/bigQueryExport`)
  if (!getRes.ok) {
    return { success: false, message: `Could not read BigQuery export settings (ensure BigQuery export is provisioned for this instance): ${secopsErrorMessage(getRes)}` }
  }
  const live = parseJson<LiveBigQueryExport>(getRes.body) ?? {}
  const prior = readLiveSources(live)

  const resp = await client.request('PATCH', `${parent}/bigQueryExport?updateMask=${UPDATE_MASK}`, exportBody(spec))
  if (!resp.ok) {
    return { success: false, message: `BigQuery export update failed: ${secopsErrorMessage(resp)}`, rollbackData: { entries: [{ existed: true, prior }] } }
  }

  const enabled = BQ_SOURCES.filter((s) => spec.sources[s.key].enabled).map((s) => s.label)
  return {
    success: true,
    message: enabled.length ? `Reconciled BigQuery export (enabled: ${enabled.join(', ')})` : 'Reconciled BigQuery export (all managed sources disabled)',
    rollbackData: { entries: [{ existed: true, prior }] },
  }
}
