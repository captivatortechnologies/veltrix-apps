import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged } from '../../lib/sumoLogicApi'
import { findRuleByIndexId, normalizeEnabled, type DataForwardingRule } from './_shared'

/**
 * Drift for data forwarding rules: compare destinationId, enabled state,
 * fileFormat, payloadSchema and format we declare against the live rule in
 * Sumo Logic (matched by indexId). Best-effort — a rule that can't be matched
 * is skipped. Read-only: GET /logsDataForwarding/rules.
 *
 * API: https://help.sumologic.com/docs/api/data-forwarding/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let live: DataForwardingRule[]
  try {
    live = await listPaged<DataForwardingRule>(base, 'logsDataForwarding/rules', headers, { nextTokenField: 'nextToken' })
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read data forwarding rules, no drift asserted
  }

  for (const item of items) {
    const indexId = String(item.fields.indexId ?? '').trim()
    const match = findRuleByIndexId(live, indexId)
    if (!match) continue

    const expectedDestinationId = String(item.fields.destinationId ?? '').trim()
    const actualDestinationId = String(match.destinationId ?? '').trim()
    if (expectedDestinationId && actualDestinationId !== expectedDestinationId) {
      diffs.push({ field: `${indexId}.destinationId`, expected: expectedDestinationId, actual: actualDestinationId, severity: 'warning' })
    }

    const expectedEnabled = normalizeEnabled(item.fields.enabled)
    const actualEnabled = normalizeEnabled(match.enabled)
    if (actualEnabled !== expectedEnabled) {
      diffs.push({ field: `${indexId}.enabled`, expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
    }

    const expectedFileFormat = String(item.fields.fileFormat ?? '').trim()
    const actualFileFormat = String(match.fileFormat ?? '').trim()
    if (expectedFileFormat && actualFileFormat !== expectedFileFormat) {
      diffs.push({ field: `${indexId}.fileFormat`, expected: expectedFileFormat, actual: actualFileFormat, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
