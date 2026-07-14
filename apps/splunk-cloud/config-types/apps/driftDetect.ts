import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { appPath, type LiveApp } from './deploy'
import { extractCloudAppSpecs } from './validate'

/**
 * Detect drift between the deployed app canvas and the live ACS state.
 *
 * Severity policy:
 *   - app uninstalled / stack unreachable ......... critical (and uninstalling
 *     destroyed the app's local/, so this is not recoverable by redeploying alone)
 *   - status is not "installed" ................... critical (the app is inert)
 *   - version differs ............................. warning  (someone installed
 *     another package over ours; a DOWNGRADE needs uninstall-then-install)
 *   - label differs ............................... info
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
  const experience = settings.experience

  const specs = extractCloudAppSpecs(ctx.deployedConfig).filter((s) => s.appId)

  for (const spec of specs) {
    try {
      const res = await acsRequest(acs, 'GET', appPath(experience, spec.appId))

      if (res.status === 404) {
        diffs.push({
          field: spec.appId,
          expected: 'installed',
          actual: 'missing',
          severity: 'critical',
        })
        continue
      }
      if (res.status !== 200) {
        diffs.push({
          field: spec.appId,
          expected: 'readable',
          actual: `ACS returned HTTP ${res.status}`,
          severity: 'critical',
        })
        continue
      }

      const live = parseJson<LiveApp>(res.body) ?? {}

      if (live.status && live.status !== 'installed') {
        diffs.push({
          field: `${spec.appId}.status`,
          expected: 'installed',
          actual: live.status,
          severity: 'critical',
        })
      }

      if (spec.version && live.version && live.version !== spec.version) {
        diffs.push({
          field: `${spec.appId}.version`,
          expected: spec.version,
          actual: live.version,
          severity: 'warning',
        })
      }

      if (spec.label && live.label && live.label !== spec.label) {
        diffs.push({
          field: `${spec.appId}.label`,
          expected: spec.label,
          actual: live.label,
          severity: 'info',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.appId,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
