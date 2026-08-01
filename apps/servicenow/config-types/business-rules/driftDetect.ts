import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildServiceNowClient, resultList } from '../../lib/servicenowApi'
import {
  SYS_SCRIPT_TABLE,
  MANAGED_COLUMNS,
  buildRecordBody,
  findRecord,
  identityQuery,
  normalizeBool,
  normalizeOrder,
  type SysScriptRecord,
} from './_shared'

/**
 * Drift for business rules: compare the managed fields we declare against the
 * live sys_script record in ServiceNow. Best-effort — a rule that cannot be
 * matched (missing / transient error) is skipped rather than raising false
 * drift. Read-only: GET /table/sys_script (one targeted query per rule).
 */
const BOOL_COLUMNS = new Set(['active', 'advanced', 'action_insert', 'action_update', 'action_delete', 'action_query'])

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildServiceNowClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const collection = String(item.fields.collection ?? '').trim()
    if (!name || !collection) continue

    let live
    try {
      const res = await client.list(SYS_SCRIPT_TABLE, {
        query: identityQuery(name, collection),
        fields: ['sys_id', ...MANAGED_COLUMNS],
        limit: 1,
      })
      if (!res.ok) continue
      live = findRecord(resultList(res) as SysScriptRecord[], name, collection)
    } catch {
      continue // best-effort
    }
    if (!live) continue

    const label = `${name} (${collection})`
    const expected = buildRecordBody(item.fields)

    for (const col of MANAGED_COLUMNS) {
      if (col === 'name' || col === 'collection') continue // identity, always matches
      const exp = expected[col]
      const act = (live as Record<string, unknown>)[col]

      let mismatch = false
      if (BOOL_COLUMNS.has(col)) {
        mismatch = normalizeBool(exp) !== normalizeBool(act)
      } else if (col === 'order') {
        mismatch = normalizeOrder(exp) !== normalizeOrder(act)
      } else {
        mismatch = String(exp ?? '') !== String(act ?? '')
      }

      if (mismatch) {
        diffs.push({
          field: `${label}.${col}`,
          expected: BOOL_COLUMNS.has(col) ? normalizeBool(exp) : col === 'order' ? normalizeOrder(exp) : exp,
          actual: BOOL_COLUMNS.has(col) ? normalizeBool(act) : col === 'order' ? normalizeOrder(act) : (act ?? ''),
          severity: col === 'script' || col === 'active' ? 'critical' : 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
