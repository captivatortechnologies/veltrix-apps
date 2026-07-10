import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { extractIndexSpecs, type LiveIndex } from './validate'

/**
 * Detect drift between the deployed index configuration and the live
 * ACS state. GETs each declared index and diffs the managed fields.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const specs = extractIndexSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const res = await acsRequest(acs, 'GET', `/indexes/${encodeURIComponent(spec.name)}`)

      if (res.status === 404) {
        diffs.push({
          field: spec.name,
          expected: 'exists',
          actual: 'missing',
          severity: 'critical',
        })
        continue
      }
      if (res.status !== 200) {
        diffs.push({
          field: spec.name,
          expected: 'readable',
          actual: `ACS returned HTTP ${res.status}`,
          severity: 'critical',
        })
        continue
      }

      const live = parseJson<LiveIndex>(res.body) ?? {}

      // datatype is immutable — a mismatch means the index was recreated out-of-band
      if (live.datatype && live.datatype !== spec.datatype) {
        diffs.push({
          field: `${spec.name}.datatype`,
          expected: spec.datatype,
          actual: live.datatype,
          severity: 'critical',
        })
      }

      if (spec.searchableDays !== undefined && Number(live.searchableDays) !== spec.searchableDays) {
        diffs.push({
          field: `${spec.name}.searchableDays`,
          expected: spec.searchableDays,
          actual: live.searchableDays,
          // Shorter retention than declared risks premature data expiry
          severity: Number(live.searchableDays) < spec.searchableDays ? 'critical' : 'warning',
        })
      }

      if (spec.maxDataSizeMB !== undefined && Number(live.maxDataSizeMB) !== spec.maxDataSizeMB) {
        diffs.push({
          field: `${spec.name}.maxDataSizeMB`,
          expected: spec.maxDataSizeMB,
          actual: live.maxDataSizeMB,
          severity: 'warning',
        })
      }

      if (
        spec.splunkArchivalRetentionDays !== undefined &&
        spec.splunkArchivalRetentionDays > 0 &&
        Number(live.splunkArchivalRetentionDays) !== spec.splunkArchivalRetentionDays
      ) {
        diffs.push({
          field: `${spec.name}.splunkArchivalRetentionDays`,
          expected: spec.splunkArchivalRetentionDays,
          actual: live.splunkArchivalRetentionDays,
          severity:
            Number(live.splunkArchivalRetentionDays ?? 0) < spec.splunkArchivalRetentionDays
              ? 'critical'
              : 'warning',
        })
      }

      if (spec.selfStorageBucketPath && live.selfStorageBucketPath !== spec.selfStorageBucketPath) {
        diffs.push({
          field: `${spec.name}.selfStorageBucketPath`,
          expected: spec.selfStorageBucketPath,
          actual: live.selfStorageBucketPath ?? 'not set',
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
