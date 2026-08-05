import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { appPath } from './deploy'
import { extractSplunkbaseAppSpecs } from './validate'

interface LiveSplunkbaseApp {
  version?: string
  status?: string
}

/**
 * Detect drift between the deployed Splunkbase-app canvas and the live ACS
 * state. Severity policy mirrors the private-app type: uninstalled/unreachable
 * is critical, a non-"installed" status is critical, a version mismatch is a
 * warning (someone installed a different version outside this canvas).
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
  const experience = settings.experience

  const specs = extractSplunkbaseAppSpecs(ctx.deployedConfig).filter((s) => s.appName)

  for (const spec of specs) {
    try {
      const res = await acsRequest(acs, 'GET', appPath(experience, spec.appName))

      if (res.status === 404) {
        diffs.push({ field: spec.appName, expected: 'installed', actual: 'missing', severity: 'critical' })
        continue
      }
      if (res.status !== 200) {
        diffs.push({
          field: spec.appName,
          expected: 'readable',
          actual: `ACS returned HTTP ${res.status}`,
          severity: 'critical',
        })
        continue
      }

      const live = parseJson<LiveSplunkbaseApp>(res.body) ?? {}

      if (live.status && live.status !== 'installed') {
        diffs.push({
          field: `${spec.appName}.status`,
          expected: 'installed',
          actual: live.status,
          severity: 'critical',
        })
      }

      if (spec.version && live.version && live.version !== spec.version) {
        diffs.push({
          field: `${spec.appName}.version`,
          expected: spec.version,
          actual: live.version,
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.appName,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
