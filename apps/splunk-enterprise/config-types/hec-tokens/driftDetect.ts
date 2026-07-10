import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader } from '../../lib/splunkApi'
import { HEC_BASE_PATH } from './deploy'

/**
 * Detect drift between deployed HEC token canvas config and the live
 * token settings on the Splunk component.
 *
 * Severity policy:
 *  - missing token / unreachable component ......... critical
 *  - token disabled while canvas expects enabled ... critical (ingestion stopped)
 *  - widened index allow-list ...................... warning (data can land anywhere)
 *  - routing changes (index/sourcetype/source) ..... warning
 *  - useACK / description changes .................. info
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, deployedConfig } = ctx
  const diffs: DriftDiff[] = []

  if (!credential || !connectivity) return { hasDrift: false, diffs: [] }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  for (const section of deployedConfig.sections) {
    const fields = section.fields
    const tokenName = fields.name as string
    if (!tokenName) continue

    try {
      const res = await fetch(`${baseUrl}${HEC_BASE_PATH}/${encodeURIComponent(tokenName)}?output_mode=json`, {
        method: 'GET', headers: auth, signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        if (res.status === 404) {
          diffs.push({ field: tokenName, expected: 'exists', actual: 'missing', severity: 'critical' })
        }
        continue
      }

      const data = JSON.parse(await res.text())
      const actual = data?.entry?.[0]?.content || {}

      // Enabled state
      if (typeof fields.enabled === 'boolean') {
        const actuallyDisabled = actual.disabled === true || actual.disabled === '1' || actual.disabled === 1
        if (fields.enabled === actuallyDisabled) {
          diffs.push({
            field: `${tokenName}.enabled`,
            expected: fields.enabled,
            actual: !actuallyDisabled,
            severity: fields.enabled ? 'critical' : 'warning',
          })
        }
      }

      // Default index
      if (typeof fields.defaultIndex === 'string' && fields.defaultIndex) {
        const actualIndex = String(actual.index ?? '')
        if (actualIndex !== fields.defaultIndex) {
          diffs.push({ field: `${tokenName}.defaultIndex`, expected: fields.defaultIndex, actual: actualIndex, severity: 'warning' })
        }
      }

      // Allowed indexes (live value may be an array or a comma-separated string)
      if (Array.isArray(fields.allowedIndexes) && fields.allowedIndexes.length > 0) {
        const expected = (fields.allowedIndexes as string[]).map(String).sort()
        const actualList = normalizeList(actual.indexes)
        if (JSON.stringify(expected) !== JSON.stringify(actualList)) {
          const widened = actualList.length === 0 || actualList.some((i) => !expected.includes(i))
          diffs.push({
            field: `${tokenName}.allowedIndexes`,
            expected,
            actual: actualList,
            severity: widened ? 'warning' : 'info',
          })
        }
      }

      // Sourcetype / source routing
      if (typeof fields.defaultSourcetype === 'string' && fields.defaultSourcetype) {
        const actualSourcetype = String(actual.sourcetype ?? '')
        if (actualSourcetype !== fields.defaultSourcetype) {
          diffs.push({ field: `${tokenName}.defaultSourcetype`, expected: fields.defaultSourcetype, actual: actualSourcetype, severity: 'warning' })
        }
      }
      if (typeof fields.defaultSource === 'string' && fields.defaultSource) {
        const actualSource = String(actual.source ?? '')
        if (actualSource !== fields.defaultSource) {
          diffs.push({ field: `${tokenName}.defaultSource`, expected: fields.defaultSource, actual: actualSource, severity: 'warning' })
        }
      }

      // Indexer acknowledgment
      if (typeof fields.useACK === 'boolean') {
        const actualAck = actual.useACK === true || actual.useACK === '1' || actual.useACK === 1
        if (actualAck !== fields.useACK) {
          diffs.push({ field: `${tokenName}.useACK`, expected: fields.useACK, actual: actualAck, severity: 'info' })
        }
      }
    } catch (error) {
      diffs.push({
        field: tokenName,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Normalize Splunk's indexes value (array or comma-separated string) to a sorted list. */
function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).sort()
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((v) => v.trim()).filter(Boolean).sort()
  }
  return []
}
