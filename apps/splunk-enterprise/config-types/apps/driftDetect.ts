import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader } from '../../lib/splunkApi'
import { APP_BASE_PATH } from './deploy'

/**
 * Detect drift between the deployed app canvas config and the live app state
 * on the Splunk component.
 *
 * Severity policy:
 *  - missing app / unreachable component ............ critical
 *  - app disabled while canvas expects enabled ...... critical (functionality lost)
 *  - app enabled while canvas expects disabled ...... warning
 *  - version changed ................................ warning
 *  - label changed .................................. info
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, deployedConfig } = ctx
  const diffs: DriftDiff[] = []

  if (!credential || !connectivity) return { hasDrift: false, diffs: [] }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  for (const section of deployedConfig.sections) {
    const fields = section.fields
    const appId = fields.name as string
    if (!appId) continue

    try {
      const res = await fetch(`${baseUrl}${APP_BASE_PATH}/${encodeURIComponent(appId)}?output_mode=json`, {
        method: 'GET', headers: auth, signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        if (res.status === 404) {
          diffs.push({ field: appId, expected: 'installed', actual: 'missing', severity: 'critical' })
        }
        continue
      }

      const data = JSON.parse(await res.text())
      const actual = data?.entry?.[0]?.content || {}

      // Enabled state
      const expectEnabled = ((fields.state as string | undefined) ?? 'enabled') !== 'disabled'
      const actuallyDisabled = actual.disabled === true || actual.disabled === '1' || actual.disabled === 1
      const actuallyEnabled = !actuallyDisabled
      if (actuallyEnabled !== expectEnabled) {
        diffs.push({
          field: `${appId}.state`,
          expected: expectEnabled ? 'enabled' : 'disabled',
          actual: actuallyEnabled ? 'enabled' : 'disabled',
          severity: expectEnabled ? 'critical' : 'warning',
        })
      }

      // Version pin
      if (typeof fields.version === 'string' && fields.version) {
        const actualVersion = String(actual.version ?? '')
        if (actualVersion !== fields.version) {
          diffs.push({ field: `${appId}.version`, expected: fields.version, actual: actualVersion, severity: 'warning' })
        }
      }

      // Display label
      if (typeof fields.label === 'string' && fields.label) {
        const actualLabel = String(actual.label ?? '')
        if (actualLabel !== fields.label) {
          diffs.push({ field: `${appId}.label`, expected: fields.label, actual: actualLabel, severity: 'info' })
        }
      }
    } catch (error) {
      diffs.push({
        field: appId,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
