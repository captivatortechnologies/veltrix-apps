import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, parseJson, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractDataTableSpecs, type LiveDataTable } from './validate'

const enc = encodeURIComponent

type Diffs = DriftResult['diffs']

function sortedRows(rows: string[][]): string {
  return JSON.stringify([...rows].map((r) => r.join('')).sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractDataTableSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  for (const spec of specs) {
    const getRes = await client.request('GET', `${parent}/dataTables/${enc(spec.name)}`)
    if (getRes.status === 404) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!getRes.ok) continue
    const live = parseJson<LiveDataTable>(getRes.body)
    if ((live?.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live?.description ?? '', severity: 'warning' })
    }
    const rowsRes = await client.request('GET', `${parent}/dataTables/${enc(spec.name)}/dataTableRows?pageSize=1000`)
    if (rowsRes.ok) {
      const parsed = parseJson<{ dataTableRows?: Array<{ values?: string[] }> }>(rowsRes.body)
      const liveRows = (parsed?.dataTableRows ?? []).map((r) => r.values ?? [])
      if (sortedRows(liveRows) !== sortedRows(spec.rows)) {
        diffs.push({ field: `${spec.name}.rows`, expected: `${spec.rows.length} row(s)`, actual: `${liveRows.length} row(s)`, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
