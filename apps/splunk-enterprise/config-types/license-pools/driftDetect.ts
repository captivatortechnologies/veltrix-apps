import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, splunkFetch } from '../../lib/splunkApi'
import { auditClientFromBase, attachDriftActor, veltrixActorLogins } from '../lib/splunkAudit'
import { LICENSE_POOLS_PATH, parseQuotaBytes } from './deploy'

/**
 * Detect drift between deployed license pool canvas config and the live
 * pool settings on the Splunk component.
 *
 * Severity policy:
 *  - missing pool / unreachable component ......... critical
 *  - stack mismatch ................................ critical (pool is on the wrong entitlement)
 *  - quota mismatch beyond a rounding tolerance .... warning
 *  - peers changed .................................. warning (changes which indexers can index)
 *  - description changed ............................ info
 *
 * Quota comparison tolerates a small delta (the canvas value is converted
 * client-side with 1024-based units; Splunk's own internal rounding is not
 * independently documented) rather than requiring byte-for-byte equality.
 */
const QUOTA_TOLERANCE_RATIO = 0.01

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig } = ctx
  const diffs: DriftDiff[] = []

  if (!credential || (!connectivity && !connectivityProvider)) return { hasDrift: false, diffs: [] }

  const baseUrl = buildSplunkUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  const auditClient = auditClientFromBase(baseUrl, auth)
  const excludeLogins = veltrixActorLogins(credential)

  for (const section of deployedConfig.sections) {
    const fields = section.fields
    const name = fields.name as string
    if (!name) continue

    const objectDiffs: DriftDiff[] = []
    try {
      const res = await splunkFetch(`${baseUrl}${LICENSE_POOLS_PATH}/${encodeURIComponent(name)}?output_mode=json`, {
        method: 'GET', headers: auth, timeoutMs: 15_000,
      })

      if (!res.ok) {
        if (res.status === 404) {
          objectDiffs.push({ field: name, expected: 'exists', actual: 'missing', severity: 'critical' })
        }
      } else {
        const data = JSON.parse(await res.text())
        const actual = data?.entry?.[0]?.content || {}

        if (typeof fields.stackId === 'string' && fields.stackId) {
          const actualStack = String(actual.stack_id ?? '')
          if (actualStack !== fields.stackId) {
            objectDiffs.push({ field: `${name}.stackId`, expected: fields.stackId, actual: actualStack, severity: 'critical' })
          }
        }

        if (typeof fields.quota === 'string' && fields.quota) {
          const expectedBytes = parseQuotaBytes(fields.quota)
          const actualBytes = Number(actual.quota ?? NaN)
          if (expectedBytes !== null && expectedBytes !== 'MAX' && Number.isFinite(actualBytes)) {
            const delta = Math.abs(actualBytes - expectedBytes)
            if (delta > expectedBytes * QUOTA_TOLERANCE_RATIO) {
              objectDiffs.push({ field: `${name}.quota`, expected: fields.quota, actual: actual.quota, severity: 'warning' })
            }
          }
        }

        if (typeof fields.peers === 'string' && fields.peers.trim() && fields.peers.trim() !== '*') {
          const expected = normalizeList(fields.peers)
          const actualList = normalizeList(actual.peers)
          if (JSON.stringify(expected) !== JSON.stringify(actualList)) {
            objectDiffs.push({ field: `${name}.peers`, expected, actual: actualList, severity: 'warning' })
          }
        }

        if (typeof fields.description === 'string' && fields.description) {
          const actualDescription = String(actual.description ?? '')
          if (actualDescription !== fields.description) {
            objectDiffs.push({ field: `${name}.description`, expected: fields.description, actual: actualDescription, severity: 'info' })
          }
        }
      }
    } catch (error) {
      objectDiffs.push({
        field: name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }

    if (objectDiffs.length > 0) {
      await attachDriftActor(auditClient, objectDiffs, { objectName: name, excludeActorLogins: excludeLogins })
      diffs.push(...objectDiffs)
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Normalize Splunk's peers value (array or comma-separated string) to a sorted list. */
function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).sort()
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((v) => v.trim()).filter(Boolean).sort()
  }
  return []
}
