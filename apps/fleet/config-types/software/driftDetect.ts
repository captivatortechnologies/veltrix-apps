import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { normalizeItem, findTitleByIdentifier } from './_shared'

/**
 * Drift for software: for each declared title, compare self-service and (per
 * source) categories / install script / auto-update against the live title.
 * Best-effort — a title that can't be found or read is skipped rather than
 * raising false drift. Like queries/labels/policies, this only checks
 * DECLARED titles — software added to Fleet outside this canvas is not
 * flagged as unexpected.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const rawItems = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const raw of rawItems) {
    const item = normalizeItem(raw.fields)
    if (!item.identifier) continue

    const live = await findTitleByIdentifier(base, headers, item.teamId, item.sourceType, item.identifier)
    if (!live) {
      diffs.push({ field: item.identifier, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    if (item.sourceType === 'fleet_maintained') {
      const pkg = live.software_package
      if (pkg && pkg.self_service !== undefined && pkg.self_service !== item.selfService) {
        diffs.push({ field: `${item.identifier}.selfService`, expected: item.selfService, actual: pkg.self_service, severity: 'warning' })
      }
      if (pkg?.install_script !== undefined && item.installScript && pkg.install_script !== item.installScript) {
        diffs.push({ field: `${item.identifier}.installScript`, expected: item.installScript, actual: pkg.install_script, severity: 'warning' })
      }
    } else {
      const app = live.app_store_app
      if (app && app.self_service !== undefined && app.self_service !== item.selfService) {
        diffs.push({ field: `${item.identifier}.selfService`, expected: item.selfService, actual: app.self_service, severity: 'warning' })
      }
      if (app && app.auto_update_enabled !== undefined && app.auto_update_enabled !== item.autoUpdateEnabled) {
        diffs.push({ field: `${item.identifier}.autoUpdateEnabled`, expected: item.autoUpdateEnabled, actual: app.auto_update_enabled, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
