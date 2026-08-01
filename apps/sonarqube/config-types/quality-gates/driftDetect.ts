import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson } from '../../lib/sonarqubeApi'
import {
  parseConditions,
  dedupeByMetric,
  normalizeBool,
  gatesFromList,
  findGate,
  formatCondition,
  type SonarCondition,
  type SonarQualityGate,
} from './_shared'

/**
 * Drift for quality gates: compare the conditions and default flag we declare against
 * the live gate in SonarQube. Best-effort — a gate that can't be matched (missing /
 * transient error) is skipped rather than raising false drift. Read-only:
 *   GET /api/qualitygates/list           → live gates + which is default
 *   GET /api/qualitygates/show?name=..    → the gate's live conditions
 * Verify against your SonarQube version.
 */
interface ShowGateResponse {
  conditions?: SonarCondition[]
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live: SonarQualityGate[]
  try {
    live = gatesFromList(await getJson<unknown>(`${base}/api/qualitygates/list`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read gates, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findGate(live, name)
    if (!match) {
      diffs.push({ field: `${name}`, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    // Default flag drift.
    const expectedDefault = normalizeBool(item.fields.isDefault)
    if (expectedDefault && match.isDefault !== true) {
      diffs.push({ field: `${name}.isDefault`, expected: true, actual: Boolean(match.isDefault), severity: 'warning' })
    }

    // Condition drift (by metric).
    let liveConditions: SonarCondition[] = []
    try {
      const shown = await getJson<ShowGateResponse>(`${base}/api/qualitygates/show?name=${encodeURIComponent(name)}`, headers)
      liveConditions = Array.isArray(shown.conditions) ? shown.conditions : []
    } catch {
      continue // can't read this gate's conditions — skip rather than assert drift
    }

    const { conditions: desired } = dedupeByMetric(parseConditions(item.fields.conditions).conditions)
    const liveByMetric = new Map(liveConditions.map((c) => [c.metric, c]))
    const desiredByMetric = new Map(desired.map((c) => [c.metric, c]))

    for (const [metric, want] of desiredByMetric) {
      const have = liveByMetric.get(metric)
      if (!have) {
        diffs.push({ field: `${name}.${metric}`, expected: formatCondition(want), actual: '(absent)', severity: 'warning' })
      } else if (String(have.op) !== want.op || String(have.error) !== want.error) {
        diffs.push({ field: `${name}.${metric}`, expected: formatCondition(want), actual: formatCondition(have), severity: 'warning' })
      }
    }
    for (const [metric, have] of liveByMetric) {
      if (!desiredByMetric.has(metric)) {
        diffs.push({ field: `${name}.${metric}`, expected: '(absent)', actual: formatCondition(have), severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
