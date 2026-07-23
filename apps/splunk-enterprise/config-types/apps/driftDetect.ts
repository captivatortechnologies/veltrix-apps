import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, splunkFetch } from '../../lib/splunkApi'
import { auditClientFromBase, attachDriftActor, veltrixActorLogins } from '../lib/splunkAudit'
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

  // Who/when attribution: resolved per drifted object from the _audit index,
  // excluding the connection's own service account (our deploys). Best-effort.
  const auditClient = auditClientFromBase(baseUrl, auth)
  const excludeLogins = veltrixActorLogins(credential)

  for (const section of deployedConfig.sections) {
    const fields = section.fields
    const appId = fields.name as string
    if (!appId) continue

    const objectDiffs: DriftDiff[] = []
    try {
      const res = await splunkFetch(`${baseUrl}${APP_BASE_PATH}/${encodeURIComponent(appId)}?output_mode=json`, {
        method: 'GET', headers: auth, timeoutMs: 15_000,
      })

      if (!res.ok) {
        if (res.status === 404) {
          objectDiffs.push({ field: appId, expected: 'installed', actual: 'missing', severity: 'critical' })
        }
      } else {
        const data = JSON.parse(await res.text())
        const actual = data?.entry?.[0]?.content || {}

        // Enabled state
        const expectEnabled = ((fields.state as string | undefined) ?? 'enabled') !== 'disabled'
        const actuallyDisabled = actual.disabled === true || actual.disabled === '1' || actual.disabled === 1
        const actuallyEnabled = !actuallyDisabled
        if (actuallyEnabled !== expectEnabled) {
          objectDiffs.push({
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
            objectDiffs.push({ field: `${appId}.version`, expected: fields.version, actual: actualVersion, severity: 'warning' })
          }
        }

        // Display label
        if (typeof fields.label === 'string' && fields.label) {
          const actualLabel = String(actual.label ?? '')
          if (actualLabel !== fields.label) {
            objectDiffs.push({ field: `${appId}.label`, expected: fields.label, actual: actualLabel, severity: 'info' })
          }
        }
      }
    } catch (error) {
      objectDiffs.push({
        field: appId,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }

    // Only query the audit index for objects that actually drifted; attribute
    // WHO/WHEN once for the object and stamp it onto all of its diffs.
    if (objectDiffs.length > 0) {
      await attachDriftActor(auditClient, objectDiffs, { objectName: appId, excludeActorLogins: excludeLogins })
      diffs.push(...objectDiffs)
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
