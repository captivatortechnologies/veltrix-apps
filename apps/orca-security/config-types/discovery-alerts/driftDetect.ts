import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { canonicalJson, normalizeBool, parseJsonField, priorServerId, readPriorRollback } from '../../lib/reconcile'
import {
  alertFromEnvelope,
  fromApiComplianceFrameworks,
  normalizeScore,
  type ComplianceFrameworkRef,
  type OrcaDiscoveryAlert,
} from './_shared'

/**
 * Drift for discovery alerts: for each declared item, recover the rule id this
 * canvas assigned, GET the live rule and compare the managed fields (category,
 * score, context flag, the Discovery query and the compliance framework
 * associations) against what we declare. Best-effort — an item with no known
 * id, or a rule that can't be read, is skipped. Read-only: GET
 * /api/sonar/rules/{id}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const previousData = await readPriorRollback<OrcaDiscoveryAlert>(ctx)

  for (const item of items) {
    const itemId = item.id ?? ''
    const name = String(item.fields.name ?? '').trim()
    const knownId = priorServerId(previousData.previous, itemId, name)
    if (!knownId) continue

    const live = await readDiscoveryAlert(client, knownId)
    if (!live) continue

    compare(diffs, name, 'category', String(item.fields.category ?? '').trim(), String(live.category ?? '').trim())
    compare(diffs, name, 'orcaScore', normalizeScore(item.fields.orcaScore), normalizeScore(live.orca_score))
    compare(diffs, name, 'contextScore', normalizeBool(item.fields.contextScore, true), normalizeBool(live.context_score, true))

    const ruleJson = parseJsonField(item.fields.ruleJson, 'Discovery query')
    if (ruleJson.ok) {
      compare(diffs, name, 'ruleJson', canonicalJson(ruleJson.value), canonicalJson(live.rule_json))
    }

    const rawFrameworks = typeof item.fields.complianceFrameworks === 'string' ? item.fields.complianceFrameworks.trim() : ''
    const expectedFrameworks = rawFrameworks
      ? parseJsonField<ComplianceFrameworkRef[]>(item.fields.complianceFrameworks, 'Compliance frameworks')
      : { ok: true as const, value: [] as ComplianceFrameworkRef[] }
    if (expectedFrameworks.ok) {
      const liveFrameworks = fromApiComplianceFrameworks(live.compliance_frameworks)
      compare(diffs, name, 'complianceFrameworks', canonicalJson(expectedFrameworks.value), canonicalJson(liveFrameworks))
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compare(diffs: DriftDiff[], label: string, field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
  }
}

async function readDiscoveryAlert(client: OrcaClient, id: string): Promise<OrcaDiscoveryAlert | null> {
  const res = await client.request<unknown>('GET', `/api/sonar/rules/${encodeURIComponent(id)}`)
  if (res.error) return null
  return alertFromEnvelope(res.data)
}
