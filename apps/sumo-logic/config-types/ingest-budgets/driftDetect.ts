import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged } from '../../lib/sumoLogicApi'
import { findIngestBudget, toCapacityBytes, type IngestBudget } from './_shared'

/**
 * Drift for ingest budgets: compare scope, capacity, action, reset time and time
 * zone we declare against the live budget in Sumo Logic (matched by name).
 * Best-effort — a budget that can't be matched is skipped. Read-only:
 * GET /ingestBudgets.
 *
 * API: https://help.sumologic.com/docs/api/ingest-budget-v2/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity, 'v2')
  const headers = buildAuthHeader(credential!)

  let live: IngestBudget[]
  try {
    live = await listPaged<IngestBudget>(base, 'ingestBudgets', headers)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read ingest budgets, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findIngestBudget(live, name)
    if (!match) continue

    const expectedScope = String(item.fields.scope ?? '').trim()
    const actualScope = String(match.scope ?? '').trim()
    if (expectedScope && actualScope !== expectedScope) {
      diffs.push({ field: `${name}.scope`, expected: expectedScope, actual: actualScope, severity: 'warning' })
    }

    const expectedCapacity = toCapacityBytes(item.fields.capacityBytes)
    if (expectedCapacity !== undefined && match.capacityBytes !== expectedCapacity) {
      diffs.push({ field: `${name}.capacityBytes`, expected: expectedCapacity, actual: match.capacityBytes, severity: 'warning' })
    }

    const expectedAction = String(item.fields.action ?? '').trim() || 'keepCollecting'
    const actualAction = String(match.action ?? '').trim()
    if (actualAction && actualAction !== expectedAction) {
      diffs.push({ field: `${name}.action`, expected: expectedAction, actual: actualAction, severity: 'warning' })
    }

    const expectedReset = String(item.fields.resetTime ?? '').trim() || '00:00'
    const actualReset = String(match.resetTime ?? '').trim()
    if (actualReset && actualReset !== expectedReset) {
      diffs.push({ field: `${name}.resetTime`, expected: expectedReset, actual: actualReset, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
