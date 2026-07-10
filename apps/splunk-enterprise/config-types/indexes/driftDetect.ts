import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader } from '../../lib/splunkApi'

/**
 * Detect drift between the deployed canvas config and the live index
 * settings on the Splunk component (/services/data/indexes/<name>).
 *
 * Severity policy:
 *  - missing index / unreachable component ............ critical
 *  - retention shorter than declared (data loss risk) .. critical
 *  - sizing / retention / bucket-mode mismatches ........ warning
 *  - cosmetic differences (journal codec) ............... info
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, deployedConfig } = ctx
  const diffs: DriftDiff[] = []

  if (!credential || !connectivity) {
    return { hasDrift: false, diffs: [] }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  for (const section of deployedConfig.sections) {
    const fields = section.fields
    const indexName = fields.name as string
    if (!indexName) continue

    try {
      const res = await fetch(
        `${baseUrl}/services/data/indexes/${encodeURIComponent(indexName)}?output_mode=json`,
        { method: 'GET', headers: auth, signal: AbortSignal.timeout(15_000) },
      )

      if (!res.ok) {
        if (res.status === 404) {
          diffs.push({ field: indexName, expected: 'exists', actual: 'missing', severity: 'critical' })
        }
        continue
      }

      const data = JSON.parse(await res.text())
      const actual = data?.entry?.[0]?.content || {}

      // Index disabled out-of-band
      if (actual.disabled === true || actual.disabled === '1') {
        diffs.push({ field: `${indexName}.disabled`, expected: false, actual: true, severity: 'critical' })
      }

      // Total size cap (canvas maxDataSizeMB → Splunk maxTotalDataSizeMB)
      if (typeof fields.maxDataSizeMB === 'number') {
        const actualMB = Number(actual.maxTotalDataSizeMB)
        if (!Number.isNaN(actualMB) && actualMB !== fields.maxDataSizeMB) {
          diffs.push({
            field: `${indexName}.maxDataSizeMB`,
            expected: fields.maxDataSizeMB,
            actual: actualMB,
            severity: 'warning',
          })
        }
      }

      // Retention (canvas frozenTimeDays → Splunk frozenTimePeriodInSecs)
      if (typeof fields.frozenTimeDays === 'number') {
        const expectedSecs = fields.frozenTimeDays * 86400
        const actualSecs = Number(actual.frozenTimePeriodInSecs || 0)
        if (actualSecs !== expectedSecs) {
          diffs.push({
            field: `${indexName}.frozenTimeDays`,
            expected: fields.frozenTimeDays,
            actual: Math.round(actualSecs / 86400),
            // Shorter-than-declared retention means data is being deleted early
            severity: actualSecs < expectedSecs ? 'critical' : 'warning',
          })
        }
      }

      // Per-bucket size mode (canvas maxDataSizeMode → Splunk maxDataSize)
      const mode = fields.maxDataSizeMode as string | undefined
      if (mode) {
        const expectedBucket =
          mode === 'custom' ? String(fields.maxDataSizeCustomMB ?? '') : mode
        const actualBucket = String(actual.maxDataSize ?? '')
        if (expectedBucket && actualBucket && expectedBucket !== actualBucket) {
          diffs.push({
            field: `${indexName}.maxDataSizeMode`,
            expected: expectedBucket,
            actual: actualBucket,
            severity: 'warning',
          })
        }
      }

      // Datatype cannot change after creation — a mismatch means the index
      // was recreated out-of-band.
      if (typeof fields.datatype === 'string' && actual.datatype && fields.datatype !== actual.datatype) {
        diffs.push({
          field: `${indexName}.datatype`,
          expected: fields.datatype,
          actual: actual.datatype,
          severity: 'critical',
        })
      }

      // Journal compression (canvas enableCompression=true deploys zstd)
      if (fields.enableCompression === true) {
        const actualCodec = String(actual.journalCompression ?? 'gzip')
        if (actualCodec !== 'zstd') {
          diffs.push({
            field: `${indexName}.enableCompression`,
            expected: 'zstd',
            actual: actualCodec,
            severity: 'info',
          })
        }
      }

      // TSIDX reduction
      if (typeof fields.enableTsidxReduction === 'boolean') {
        const actualReduction = actual.enableTsidxReduction === true || actual.enableTsidxReduction === '1'
        if (actualReduction !== fields.enableTsidxReduction) {
          diffs.push({
            field: `${indexName}.enableTsidxReduction`,
            expected: fields.enableTsidxReduction,
            actual: actualReduction,
            severity: 'warning',
          })
        }
      }
    } catch (error) {
      // Connection failure = potential drift
      diffs.push({
        field: indexName,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
