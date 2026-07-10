import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { extractHecTokenSpecs, parseHecEntity } from './validate'

const HEC_PATH = '/inputs/http-event-collectors'

/**
 * Detect drift between the deployed HEC token configuration and the live
 * ACS state. Missing tokens are critical; routing fields (defaultIndex,
 * allowedIndexes) and enabled state are warnings; metadata fields are info.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const token = resolveAcsToken(ctx.credential)
  if (!token) {
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

  const specs = extractHecTokenSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const res = await acsRequest(acs, 'GET', `${HEC_PATH}/${encodeURIComponent(spec.name)}`)

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

      const live = parseHecEntity(parseJson(res.body))?.spec ?? {}

      if (spec.defaultIndex !== undefined && live.defaultIndex !== spec.defaultIndex) {
        diffs.push({
          field: `${spec.name}.defaultIndex`,
          expected: spec.defaultIndex,
          actual: live.defaultIndex ?? 'not set',
          severity: 'warning',
        })
      }

      if (spec.allowedIndexes.length > 0) {
        const liveSet = [...(live.allowedIndexes ?? [])].sort().join(',')
        const expectedSet = [...spec.allowedIndexes].sort().join(',')
        if (liveSet !== expectedSet) {
          diffs.push({
            field: `${spec.name}.allowedIndexes`,
            expected: spec.allowedIndexes,
            actual: live.allowedIndexes ?? [],
            severity: 'warning',
          })
        }
      }

      if (spec.useAck !== undefined && (live.useAck ?? false) !== spec.useAck) {
        diffs.push({
          field: `${spec.name}.useAck`,
          expected: spec.useAck,
          actual: live.useAck ?? false,
          severity: 'warning',
        })
      }

      if (spec.disabled !== undefined && (live.disabled ?? false) !== spec.disabled) {
        diffs.push({
          field: `${spec.name}.disabled`,
          expected: spec.disabled,
          actual: live.disabled ?? false,
          severity: 'warning',
        })
      }

      if (spec.defaultSource !== undefined && (live.defaultSource ?? '') !== spec.defaultSource) {
        diffs.push({
          field: `${spec.name}.defaultSource`,
          expected: spec.defaultSource,
          actual: live.defaultSource ?? '',
          severity: 'info',
        })
      }

      if (
        spec.defaultSourcetype !== undefined &&
        (live.defaultSourcetype ?? '') !== spec.defaultSourcetype
      ) {
        diffs.push({
          field: `${spec.name}.defaultSourcetype`,
          expected: spec.defaultSourcetype,
          actual: live.defaultSourcetype ?? '',
          severity: 'info',
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
