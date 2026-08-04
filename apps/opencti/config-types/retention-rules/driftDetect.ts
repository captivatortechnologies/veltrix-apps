import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_RETENTION_RULES_QUERY, findRetentionRule, retentionRulesFromList, normalizeBool, normalizeNumber, normalizeText } from './_shared'

/**
 * Drift for retention-rules: compare scope, max_retention, retention_unit and
 * active against the live rule in OpenCTI (matched by name). `filters` is
 * intentionally NOT compared — OpenCTI may reformat/reorder the stored JSON,
 * which would raise false drift for a semantically unchanged filter. Best-
 * effort — a rule that can't be matched (missing / transient error) is
 * skipped rather than raising false drift. Read-only: retentionRules.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = retentionRulesFromList(await graphql<unknown>(base, headers, LIST_RETENTION_RULES_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read retention rules, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findRetentionRule(live, name)
    if (!match) continue

    const expectedScope = normalizeText(item.fields.scope)
    const actualScope = normalizeText(match.scope)
    if (expectedScope !== undefined && actualScope !== undefined && expectedScope !== actualScope) {
      diffs.push({ field: `${name}.scope`, expected: expectedScope, actual: actualScope, severity: 'warning' })
    }

    const expectedMaxRetention = normalizeNumber(item.fields.max_retention)
    const actualMaxRetention = normalizeNumber(match.max_retention)
    if (expectedMaxRetention !== undefined && actualMaxRetention !== undefined && expectedMaxRetention !== actualMaxRetention) {
      diffs.push({ field: `${name}.max_retention`, expected: expectedMaxRetention, actual: actualMaxRetention, severity: 'warning' })
    }

    const expectedRetentionUnit = normalizeText(item.fields.retention_unit)
    const actualRetentionUnit = normalizeText(match.retention_unit)
    if (expectedRetentionUnit !== undefined && actualRetentionUnit !== undefined && expectedRetentionUnit !== actualRetentionUnit) {
      diffs.push({ field: `${name}.retention_unit`, expected: expectedRetentionUnit, actual: actualRetentionUnit, severity: 'info' })
    }

    const expectedActive = normalizeBool(item.fields.active)
    const actualActive = normalizeBool(match.active)
    if (expectedActive !== undefined && actualActive !== undefined && expectedActive !== actualActive) {
      diffs.push({ field: `${name}.active`, expected: expectedActive, actual: actualActive, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
