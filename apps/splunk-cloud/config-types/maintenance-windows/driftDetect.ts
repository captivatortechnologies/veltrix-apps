import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { extractMaintenanceWindowSpec, PREFERENCES_PATH } from './validate'
import type { ChangeFreezePreferences } from './deploy'

/**
 * Detect drift between the deployed change freeze and live ACS state.
 * A missing freeze (matched on its start/end window) is critical; a differing
 * appliesTo scope is a warning; a differing reason is informational.
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

  const spec = extractMaintenanceWindowSpec(ctx.deployedConfig)
  if (!spec.startDate || !spec.endDate) {
    return { hasDrift: false, diffs: [] }
  }

  try {
    const res = await acsRequest(acs, 'GET', PREFERENCES_PATH)
    if (res.status !== 200) {
      return {
        hasDrift: true,
        diffs: [
          {
            field: 'maintenance-windows/preferences',
            expected: 'readable',
            actual: `ACS returned HTTP ${res.status}: ${acsErrorMessage(res)}`,
            severity: 'critical',
          },
        ],
      }
    }

    const prefs = parseJson<ChangeFreezePreferences>(res.body) ?? {}
    const live = prefs.changeFreezes?.customerInitiatedFreezes ?? []
    const match = live.find((f) => f.startDate === spec.startDate && f.endDate === spec.endDate)

    const windowLabel = `${spec.startDate}..${spec.endDate}`
    if (!match) {
      diffs.push({
        field: `change-freeze.${windowLabel}`,
        expected: 'present',
        actual: 'missing',
        severity: 'critical',
      })
    } else {
      if (match.appliesTo !== spec.appliesTo) {
        diffs.push({
          field: `change-freeze.${windowLabel}.appliesTo`,
          expected: spec.appliesTo,
          actual: match.appliesTo ?? 'unset',
          severity: 'warning',
        })
      }
      if ((match.reason ?? '') !== spec.reason) {
        diffs.push({
          field: `change-freeze.${windowLabel}.reason`,
          expected: spec.reason,
          actual: match.reason ?? 'unset',
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'maintenance-windows/preferences',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
