import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSocUrl, buildAuthHeader, getJson } from '../../lib/soConsole'
import { normalizeEnabled } from './_shared'

/**
 * Drift for detection rules: compare the enabled state, severity and query we
 * declare against the live rule on the Kibana Detection Engine. Best-effort — a
 * rule that can't be read (missing / transient error) is skipped rather than
 * raising false drift.
 */
interface LiveRule {
  enabled?: boolean
  severity?: string
  query?: string
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSocUrl(component, connectivity, connectivityProvider)
  const headers = { ...buildAuthHeader(credential), 'kbn-xsrf': 'true' }

  for (const item of items) {
    const ruleId = String(item.fields.ruleId ?? '').trim()
    if (!ruleId) continue

    let live: LiveRule | null = null
    try {
      live = await getJson<LiveRule>(`${base}/api/detection_engine/rules?rule_id=${encodeURIComponent(ruleId)}`, headers)
    } catch {
      continue // best-effort: skip a rule we can't read
    }
    if (!live) continue

    const expectedEnabled = normalizeEnabled(item.fields.enabled)
    if (typeof live.enabled === 'boolean' && live.enabled !== expectedEnabled) {
      diffs.push({ field: `${ruleId}.enabled`, expected: expectedEnabled, actual: live.enabled, severity: 'warning' })
    }

    const expectedSeverity = String(item.fields.severity ?? '')
    if (live.severity !== undefined && live.severity !== expectedSeverity) {
      diffs.push({ field: `${ruleId}.severity`, expected: expectedSeverity, actual: live.severity ?? null, severity: 'warning' })
    }

    const expectedQuery = String(item.fields.query ?? '')
    if (live.query !== undefined && live.query !== expectedQuery) {
      diffs.push({ field: `${ruleId}.query`, expected: expectedQuery, actual: live.query ?? null, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
