import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import {
  normalizeItem,
  findTitleByIdentifier,
  createFleetMaintained,
  createAppStoreApp,
  updateFleetMaintainedOverrides,
  updateAppStoreOverrides,
  type FleetSoftwarePackage,
  type FleetAppStoreApp,
} from './_shared'

interface PriorSoftware {
  sourceType: 'fleet_maintained' | 'app_store'
  identifier: string
  teamId: number
  priorTitleId: number | null
  priorPackage: FleetSoftwarePackage | null
  priorAppStoreApp: FleetAppStoreApp | null
  createdTitleId?: number
}

/**
 * Deploy Fleet software titles, upserting by identifier (Fleet-maintained-app
 * id, or App Store id) within a team scope:
 *   read (rollback): GET   /api/v1/fleet/software/titles?fleet_id=<team>   → find by identifier (miss = new title)
 *   create:          POST  /api/v1/fleet/software/fleet_maintained_apps    or  .../app_store_apps
 *   converge:        PATCH /api/v1/fleet/software/titles/{id}/package      or  .../app_store_app
 *
 * The converge step always runs (after create or when the title already
 * existed) so declared overrides (self-service, categories, install scripts,
 * auto-update) win regardless of prior state — categories in particular can
 * only be set through the update endpoints.
 *
 * rollbackData records the prior sub-object (software_package or
 * app_store_app) per identifier, or null when it did not exist, so rollback
 * can restore those overrides or delete the title we added.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const rawItems = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for software deployment' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: PriorSoftware[] = []
  const applied: string[] = []

  try {
    for (const raw of rawItems) {
      const item = normalizeItem(raw.fields)
      if (!item.identifier) continue

      const existing = await findTitleByIdentifier(base, headers, item.teamId, item.sourceType, item.identifier)
      const entry: PriorSoftware = {
        sourceType: item.sourceType,
        identifier: item.identifier,
        teamId: item.teamId,
        priorTitleId: existing?.id ?? null,
        priorPackage: existing?.software_package ?? null,
        priorAppStoreApp: existing?.app_store_app ?? null,
      }

      let titleId: number
      if (existing) {
        titleId = existing.id
      } else if (item.sourceType === 'fleet_maintained') {
        const created = await createFleetMaintained(base, headers, item)
        titleId = created.software_title_id
        entry.createdTitleId = titleId
      } else {
        const created = await createAppStoreApp(base, headers, item)
        titleId = created.software_title_id
        entry.createdTitleId = titleId
      }

      if (item.sourceType === 'fleet_maintained') {
        await updateFleetMaintainedOverrides(base, headers, titleId, item)
      } else {
        await updateAppStoreOverrides(base, headers, titleId, item)
      }

      previous.push(entry)
      applied.push(item.identifier)
    }

    return {
      success: true,
      message: `Applied ${applied.length} software title(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Software deploy failed after ${applied.length} title(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
