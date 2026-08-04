import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient } from '../../lib/jumpcloudApi'
import { listSoftwareApps } from './deploy'
import { extractSoftwareAppSpecs, findSoftwareAppByName, buildSoftwareAppSettings } from './_shared'

/**
 * Detect drift between the deployed Software App configuration and the live
 * org. Re-finds each declared app by displayName and diffs the managed settings
 * entry (matched by `appCatalogInstallableObjectId` within the live app's
 * `settings[]`, since JumpCloud may append platform-managed entries this config
 * type doesn't own). Best-effort: if the org can't be read the check reports no
 * drift rather than raising a false positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractSoftwareAppSpecs(ctx.deployedConfig).filter((s) => s.displayName)

  let liveApps
  try {
    liveApps = await listSoftwareApps(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }

  for (const spec of specs) {
    const live = findSoftwareAppByName(liveApps, spec.displayName)
    if (!live) {
      diffs.push({ field: spec.displayName, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const desired = buildSoftwareAppSettings(spec)
    const liveSettings = (live.settings ?? []).find((s) => s.appCatalogInstallableObjectId === spec.appCatalogInstallableObjectId)
    if (!liveSettings) {
      diffs.push({ field: `${spec.displayName}.settings`, expected: spec.appCatalogInstallableObjectId, actual: 'not configured', severity: 'critical' })
      continue
    }

    for (const field of ['autoUpdate', 'allowUpdateDelay', 'desiredState'] as const) {
      const liveValue = liveSettings[field]
      const desiredValue = desired[field]
      if (String(liveValue ?? '') !== String(desiredValue ?? '')) {
        diffs.push({ field: `${spec.displayName}.${field}`, expected: String(desiredValue), actual: String(liveValue ?? '(unset)'), severity: 'warning' })
      }
    }
    if (spec.displayVersion && String(liveSettings.displayVersion ?? '') !== spec.displayVersion) {
      diffs.push({ field: `${spec.displayName}.displayVersion`, expected: spec.displayVersion, actual: String(liveSettings.displayVersion ?? '(unset)'), severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
