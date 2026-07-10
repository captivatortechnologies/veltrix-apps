import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'

/**
 * Detect drift between the deployed canvas config and what's actually running on Splunk.
 * Compares expected index settings with actual settings via Splunk REST API.
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
    const indexName = section.fields.name as string
    if (!indexName) continue

    try {
      const res = await fetch(
        `${baseUrl}/services/data/indexes/${indexName}?output_mode=json`,
        { method: 'GET', headers: auth, signal: AbortSignal.timeout(15_000) },
      )

      if (!res.ok) {
        if (res.status === 404) {
          diffs.push({
            field: `${indexName}`,
            expected: 'exists',
            actual: 'missing',
            severity: 'critical',
          })
        }
        continue
      }

      const data = JSON.parse(await res.text())
      const actual = data?.entry?.[0]?.content || {}

      // Compare maxDataSize
      if (section.fields.maxDataSizeMB) {
        const expectedMB = section.fields.maxDataSizeMB
        const actualStr = actual.maxDataSize || actual.maxTotalDataSizeMB
        if (actualStr && String(actualStr) !== String(expectedMB)) {
          diffs.push({
            field: `${indexName}.maxDataSizeMB`,
            expected: expectedMB,
            actual: actualStr,
            severity: 'warning',
          })
        }
      }

      // Compare frozenTimePeriodInSecs
      if (section.fields.frozenTimeDays) {
        const expectedSecs = (section.fields.frozenTimeDays as number) * 86400
        const actualSecs = Number(actual.frozenTimePeriodInSecs || 0)
        if (actualSecs !== expectedSecs) {
          diffs.push({
            field: `${indexName}.frozenTimeDays`,
            expected: section.fields.frozenTimeDays,
            actual: Math.round(actualSecs / 86400),
            severity: actualSecs < expectedSecs ? 'critical' : 'warning',
          })
        }
      }

      // Compare compression
      if (section.fields.enableCompression !== undefined) {
        const expectedCompression = section.fields.enableCompression
        const actualCompression = actual.enableOnlineBucketRepair !== 'false'
        if (expectedCompression !== actualCompression) {
          diffs.push({
            field: `${indexName}.enableCompression`,
            expected: expectedCompression,
            actual: actualCompression,
            severity: 'info',
          })
        }
      }
    } catch (error) {
      // Connection failure = potential drift
      diffs.push({
        field: `${indexName}`,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function buildSplunkUrl(
  component: DriftContext['component'],
  connectivity: NonNullable<DriftContext['connectivity']>,
): string {
  if (connectivity.httpsUrl) return connectivity.httpsUrl
  if (connectivity.tailscaleDeviceIP) return `https://${connectivity.tailscaleDeviceIP}:${component.port || '8089'}`
  return `https://${component.hostname}:${component.port || '8089'}`
}

function buildAuthHeader(credential: NonNullable<DriftContext['credential']>): Record<string, string> {
  if (credential.apiToken) return { Authorization: `Bearer ${credential.apiToken}` }
  const encoded = Buffer.from(`${credential.username}:${credential.password}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}
