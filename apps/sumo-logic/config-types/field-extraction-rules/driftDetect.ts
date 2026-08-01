import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson } from '../../lib/sumoLogicApi'
import { rulesFromList, findRule, normalizeEnabled } from './_shared'

/**
 * Drift for field extraction rules: compare the scope, parse expression and
 * enabled state we declare against the live rule in Sumo Logic (matched by name).
 * Best-effort — a rule that can't be matched (missing / transient error) is
 * skipped rather than raising false drift. Read-only: GET /extractionRules.
 *
 * API: https://www.sumologic.com/help/docs/api/field-extraction-rules/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let live
  try {
    live = rulesFromList(await getJson<unknown>(`${base}/extractionRules`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read rules, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findRule(live, name)
    if (!match) continue

    const expectedScope = String(item.fields.scope ?? '').trim()
    const actualScope = String(match.scope ?? '').trim()
    if (expectedScope && actualScope !== expectedScope) {
      diffs.push({ field: `${name}.scope`, expected: expectedScope, actual: actualScope, severity: 'warning' })
    }

    const expectedParse = String(item.fields.parseExpression ?? '').trim()
    const actualParse = String(match.parseExpression ?? '').trim()
    if (expectedParse && actualParse !== expectedParse) {
      diffs.push({ field: `${name}.parseExpression`, expected: expectedParse, actual: actualParse, severity: 'warning' })
    }

    const expectedEnabled = normalizeEnabled(item.fields.enabled)
    const actualEnabled = normalizeEnabled(match.enabled)
    if (actualEnabled !== expectedEnabled) {
      diffs.push({ field: `${name}.enabled`, expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
