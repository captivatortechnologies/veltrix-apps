import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, splunkFetch } from '../../lib/splunkApi'
import { auditClientFromBase, attachDriftActor, veltrixActorLogins } from '../lib/splunkAudit'
import { APP_BASE_PATH } from './deploy'
import { expectedAppFiles, detectManagedContentDrift, detectRestConfigDrift } from './contentDrift'

/**
 * Detect drift between the deployed app canvas config and the live app on the
 * Splunk component — both app STATE and, for inline apps, the CONTENT of the
 * files we shipped.
 *
 * Severity policy:
 *  - missing app / unreachable component ............ critical
 *  - app disabled while canvas expects enabled ...... critical (functionality lost)
 *  - app enabled while canvas expects disabled ...... warning
 *  - version changed ................................ warning
 *  - label changed .................................. info
 *  - shipped file modified / missing ................ warning (managed: with the diff)
 *  - unexpected file added under default/ ........... info
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, remote } = ctx
  const diffs: DriftDiff[] = []

  // A managed-ZTNA server has no separate connectivity record — require only a
  // credential (buildSplunkUrl resolves the tailnet address from the provider).
  if (!credential) return { hasDrift: false, diffs: [] }

  // Scope by Target Server Types: this config only deploys to servers whose role
  // is selected, so a server outside that set isn't a drift target (matches
  // deploy + health-check). No targets set → check every component (legacy).
  const componentRoles = component.type ?? []
  const targetTypes = new Set(deployedConfig.sections.flatMap((s) => toStringArray(fieldOf(s, 'targetTypes'))))
  if (targetTypes.size > 0 && !componentRoles.some((r) => targetTypes.has(r))) {
    return { hasDrift: false, diffs: [] }
  }

  const baseUrl = buildSplunkUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  // Who/when attribution: resolved per drifted object from the _audit index,
  // excluding the connection's own service account (our deploys). Best-effort.
  const auditClient = auditClientFromBase(baseUrl, auth)
  const excludeLogins = veltrixActorLogins(credential)

  for (const section of deployedConfig.sections) {
    const fields = section.fields as Record<string, unknown>
    const appId = fields.name as string
    if (!appId) continue

    const objectDiffs: DriftDiff[] = []

    // --- App state (installed / enabled / version / label) ------------------
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

        if (typeof fields.version === 'string' && fields.version) {
          const actualVersion = String(actual.version ?? '')
          if (actualVersion !== fields.version) {
            objectDiffs.push({ field: `${appId}.version`, expected: fields.version, actual: actualVersion, severity: 'warning' })
          }
        }

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

    // --- Content drift (the files we shipped) — inline apps only ------------
    // We only know the expected bytes for an inline build. Managed-ZTNA hashes
    // the live files over the tailnet and shows the diff; a non-managed target
    // compares effective .conf values via REST. Best-effort — never fail the
    // whole check on a content-drift error.
    if ((fields.source as string | undefined) === 'inline') {
      try {
        if (remote) {
          const expected = expectedAppFiles(fields, { build: deployedConfig.version, configName: deployedConfig.name })
          objectDiffs.push(...(await detectManagedContentDrift(remote, appId, expected)))
        } else {
          objectDiffs.push(...(await detectRestConfigDrift(baseUrl, auth, appId, fields)))
        }
      } catch {
        // ignore — state drift above is still reported
      }
    }

    // Attribute WHO/WHEN once per drifted object and stamp it onto its diffs.
    if (objectDiffs.length > 0) {
      await attachDriftActor(auditClient, objectDiffs, { objectName: appId, excludeActorLogins: excludeLogins })
      diffs.push(...objectDiffs)
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function fieldOf(section: { fields?: Record<string, unknown> }, key: string): unknown {
  return section.fields?.[key]
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value) return value.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}
