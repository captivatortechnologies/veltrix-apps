import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader } from '../../lib/splunkApi'

/**
 * Detect drift between the deployed role canvas and the live role
 * definitions on the Splunk component (/services/authorization/roles/<name>).
 *
 * Severity policy:
 *  - missing role / unreachable component .......... critical
 *  - extra live capabilities (privilege creep) ...... warning
 *  - missing capabilities / filter / quota drift .... warning
 *  - cosmetic ordering differences .................. ignored (sorted compare)
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, deployedConfig } = ctx
  const diffs: DriftDiff[] = []

  if (!credential || !connectivity) return { hasDrift: false, diffs: [] }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  for (const section of deployedConfig.sections) {
    const fields = section.fields
    const roleName = fields.name as string
    if (!roleName) continue

    try {
      const res = await fetch(
        `${baseUrl}/services/authorization/roles/${encodeURIComponent(roleName)}?output_mode=json`,
        { method: 'GET', headers: auth, signal: AbortSignal.timeout(15_000) },
      )

      if (!res.ok) {
        if (res.status === 404) {
          diffs.push({ field: roleName, expected: 'exists', actual: 'missing', severity: 'critical' })
        }
        continue
      }

      const data = JSON.parse(await res.text())
      const actual = data?.entry?.[0]?.content || {}

      // Capabilities — extra live capabilities indicate privilege creep
      compareStringArrays(diffs, `${roleName}.capabilities`, fields.capabilities, actual.capabilities, {
        extraSeverity: 'warning',
        missingSeverity: 'warning',
      })

      // Imported roles
      compareStringArrays(diffs, `${roleName}.importedRoles`, fields.importedRoles, actual.imported_roles, {
        extraSeverity: 'warning',
        missingSeverity: 'warning',
      })

      // Index access lists
      compareStringArrays(diffs, `${roleName}.srchIndexesAllowed`, fields.srchIndexesAllowed, actual.srchIndexesAllowed, {
        extraSeverity: 'warning',
        missingSeverity: 'info',
      })
      compareStringArrays(diffs, `${roleName}.srchIndexesDefault`, fields.srchIndexesDefault, actual.srchIndexesDefault, {
        extraSeverity: 'info',
        missingSeverity: 'info',
      })

      // Search filter — a weakened filter widens data access
      if (fields.srchFilter) {
        const expectedFilter = fields.srchFilter as string
        const actualFilter = (actual.srchFilter as string) || ''
        if (expectedFilter !== actualFilter) {
          diffs.push({
            field: `${roleName}.srchFilter`,
            expected: expectedFilter,
            actual: actualFilter,
            severity: actualFilter === '' ? 'critical' : 'warning',
          })
        }
      }

      // Quotas
      for (const key of ['srchDiskQuota', 'srchJobsQuota', 'rtSrchJobsQuota', 'srchTimeWin'] as const) {
        if (typeof fields[key] === 'number') {
          const actualValue = Number(actual[key])
          if (!Number.isNaN(actualValue) && actualValue !== fields[key]) {
            diffs.push({ field: `${roleName}.${key}`, expected: fields[key], actual: actualValue, severity: 'warning' })
          }
        }
      }
    } catch (error) {
      diffs.push({
        field: roleName,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Order-insensitive comparison of expected vs actual string arrays. */
function compareStringArrays(
  diffs: DriftDiff[],
  field: string,
  expectedRaw: unknown,
  actualRaw: unknown,
  severities: { extraSeverity: DriftDiff['severity']; missingSeverity: DriftDiff['severity'] },
): void {
  // Field not managed by the canvas — nothing to compare against.
  if (expectedRaw === undefined) return

  const expected = (Array.isArray(expectedRaw) ? expectedRaw.map(String) : []).sort()
  const actual = (Array.isArray(actualRaw) ? actualRaw.map(String) : []).sort()
  if (JSON.stringify(expected) === JSON.stringify(actual)) return

  const missing = expected.filter((v) => !actual.includes(v))
  const extra = actual.filter((v) => !expected.includes(v))
  if (missing.length === 0 && extra.length === 0) return

  diffs.push({
    field,
    expected,
    actual,
    severity: extra.length > 0 ? severities.extraSeverity : severities.missingSeverity,
  })
}
