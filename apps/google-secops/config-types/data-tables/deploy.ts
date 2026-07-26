import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
  type SecOpsClient,
} from '../../lib/googlesecops'
import { extractDataTableSpecs, type Column, type DataTableSpec, type LiveDataTable } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: { rows: string[][] }
}

const enc = encodeURIComponent

export function buildColumnInfo(columns: Column[]): Array<Record<string, unknown>> {
  return columns.map((c, i) => ({ columnIndex: i, originalColumn: c.name, columnType: c.type }))
}

export function bulkReplaceBody(rows: string[][]): Record<string, unknown> {
  return { requests: rows.map((values) => ({ dataTableRow: { values } })) }
}

/** The live schema as a comparable "name:TYPE" list (ordered by columnIndex). */
function liveSchema(live: LiveDataTable): string {
  return [...(live.columnInfo ?? [])]
    .sort((a, b) => (a.columnIndex ?? 0) - (b.columnIndex ?? 0))
    .map((c) => `${c.originalColumn ?? ''}:${(c.columnType ?? 'STRING').toUpperCase()}`)
    .join(',')
}

function desiredSchema(spec: DataTableSpec): string {
  return spec.columns.map((c) => `${c.name}:${c.type}`).join(',')
}

async function getRows(client: SecOpsClient, parent: string, id: string): Promise<string[][]> {
  const res = await client.request('GET', `${parent}/dataTables/${enc(id)}/dataTableRows?pageSize=1000`)
  if (!res.ok) return []
  const parsed = parseJson<{ dataTableRows?: Array<{ values?: string[] }> }>(res.body)
  return (parsed?.dataTableRows ?? []).map((r) => r.values ?? [])
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractDataTableSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const getRes = await client.request('GET', `${parent}/dataTables/${enc(spec.name)}`)

    if (getRes.ok) {
      const live = parseJson<LiveDataTable>(getRes.body)
      if (live && liveSchema(live) !== desiredSchema(spec)) {
        failures.push(`${spec.name}: the column schema is immutable and differs from the live table — rename or delete the table to change columns`)
        continue
      }
      const priorRows = await getRows(client, parent, spec.name)
      const patchRes = await client.request('PATCH', `${parent}/dataTables/${enc(spec.name)}?updateMask=description`, { description: spec.description })
      if (!patchRes.ok) {
        failures.push(`${spec.name}: ${secopsErrorMessage(patchRes)}`)
        continue
      }
      const rowsRes = await client.request('POST', `${parent}/dataTables/${enc(spec.name)}/dataTableRows:bulkReplace`, bulkReplaceBody(spec.rows))
      if (!rowsRes.ok) {
        failures.push(`${spec.name}: rows: ${secopsErrorMessage(rowsRes)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: { rows: priorRows } })
    } else if (getRes.status === 404) {
      const createRes = await client.request('POST', `${parent}/dataTables?dataTableId=${enc(spec.name)}`, { description: spec.description, columnInfo: buildColumnInfo(spec.columns) })
      if (!createRes.ok) {
        failures.push(`${spec.name}: ${secopsErrorMessage(createRes)}`)
        continue
      }
      const rowsRes = await client.request('POST', `${parent}/dataTables/${enc(spec.name)}/dataTableRows:bulkReplace`, bulkReplaceBody(spec.rows))
      if (!rowsRes.ok) {
        failures.push(`${spec.name}: rows: ${secopsErrorMessage(rowsRes)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, prior: { rows: [] } })
    } else {
      failures.push(`${spec.name}: ${secopsErrorMessage(getRes)}`)
    }
  }

  // Reconcile: delete tables THIS app created previously but no longer declares.
  // Data tables (unlike reference lists) support delete; force=true drops rows too.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && !declaredNames.has(p.name.toLowerCase())) {
      const del = await client.request('DELETE', `${parent}/dataTables/${enc(p.name)}?force=true`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${p.name}: ${secopsErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some data tables failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} data table(s)`, rollbackData: { entries } }
}
