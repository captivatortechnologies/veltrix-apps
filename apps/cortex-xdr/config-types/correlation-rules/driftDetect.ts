import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'
import { CORRELATION_ENDPOINTS, findCorrelationRule, correlationRulesFromReply, normalizeName } from './_shared'

/**
 * Drift for correlation rules: compare the XQL query, severity, execution mode
 * and enabled flag we declare against the live rule in Cortex XDR. Best-effort —
 * a rule that can't be matched (missing / transient error) is skipped rather
 * than raising false drift. Read-only: POST /correlations/get/.
 *
 * VERIFY the /correlations/get response shape + field names against a live
 * Cortex XDR tenant.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.call(CORRELATION_ENDPOINTS.get, { search_from: 0, search_to: 1000 })
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = correlationRulesFromReply(res.reply)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findCorrelationRule(live, name)
    if (!match) continue

    const expectedQuery = String(item.fields.xql_query ?? '').trim()
    const actualQuery = String(match.xql_query ?? '').trim()
    if (expectedQuery && expectedQuery !== actualQuery) {
      diffs.push({ field: `${name}.xql_query`, expected: expectedQuery, actual: actualQuery, severity: 'warning' })
    }

    const expectedSeverity = String(item.fields.severity ?? '').trim()
    const actualSeverity = String(match.severity ?? '').trim()
    if (expectedSeverity && normalizeName(expectedSeverity) !== normalizeName(actualSeverity)) {
      diffs.push({ field: `${name}.severity`, expected: expectedSeverity, actual: actualSeverity, severity: 'warning' })
    }

    const expectedMode = String(item.fields.execution_mode ?? '').trim() || 'SCHEDULED'
    const actualMode = String(match.execution_mode ?? '').trim()
    if (normalizeName(expectedMode) !== normalizeName(actualMode)) {
      diffs.push({ field: `${name}.execution_mode`, expected: expectedMode, actual: actualMode, severity: 'warning' })
    }

    const expectedEnabled = item.fields.is_enabled === false || item.fields.is_enabled === 'false' ? false : true
    const actualEnabled = match.is_enabled !== false
    if (expectedEnabled !== actualEnabled) {
      diffs.push({ field: `${name}.is_enabled`, expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
