import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import {
  buildAlertBody,
  alertFromEnvelope,
  priorRuleId,
  normalizeBool,
  normalizeScore,
  type AlertRollbackData,
  type OrcaAlert,
} from './_shared'

/**
 * Drift for custom alerts: for each declared item, recover the rule id this
 * canvas assigned (from its own prior deploy's rollbackData), GET the live rule
 * and compare the managed fields (category, score, context flag, enabled, query)
 * against what we declare. Best-effort — an item with no known id, or a rule that
 * can't be read, is skipped rather than raising false drift. Read-only:
 * GET /api/sonar/rules/{id}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const previousData = await readPriorRollback(ctx)

  for (const item of items) {
    const itemId = item.id ?? ''
    const name = String(item.fields.name ?? '').trim()
    const knownId = priorRuleId(previousData.previous, itemId, name)
    if (!knownId) continue

    const live = await readAlert(client, knownId)
    if (!live) continue

    const expected = buildAlertBody(item.fields)

    compare(diffs, name, 'category', expected.category, String(live.category ?? '').trim())
    compare(diffs, name, 'orcaScore', normalizeScore(expected.orca_score), normalizeScore(live.orca_score))
    compare(diffs, name, 'contextScore', normalizeBool(expected.context_score, true), normalizeBool(live.context_score, true))
    compare(diffs, name, 'enabled', normalizeBool(expected.enabled, true), normalizeBool(live.enabled, true))
    compare(diffs, name, 'rule', (expected.rule ?? '').trim(), String(live.rule ?? '').trim())
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compare(diffs: DriftDiff[], label: string, field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
  }
}

async function readPriorRollback(ctx: DriftContext): Promise<AlertRollbackData> {
  try {
    const latest = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = latest?.rollbackData
    if (data && typeof data === 'object') return data as AlertRollbackData
  } catch {
    // best-effort
  }
  return {}
}

async function readAlert(client: OrcaClient, id: string): Promise<OrcaAlert | null> {
  const res = await client.request<unknown>('GET', `/api/sonar/rules/${encodeURIComponent(id)}`)
  if (res.error) return null
  return alertFromEnvelope(res.data)
}
