import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { updateFleetMaintainedOverrides, updateAppStoreOverrides, deleteSoftwareTitle, type FleetSoftwarePackage, type FleetAppStoreApp } from './_shared'

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
 * Undo a software deploy from rollbackData.previous (written by deploy()): for
 * each entry, restore the prior software_package / app_store_app overrides on
 * a title we updated, or DELETE the title we added. Applied over the Fleet
 * REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorSoftware[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for software rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let removed = 0
  try {
    for (const entry of previous) {
      if (entry.priorTitleId !== null) {
        if (entry.sourceType === 'fleet_maintained') {
          const prior = entry.priorPackage
          await updateFleetMaintainedOverrides(base, headers, entry.priorTitleId, {
            teamId: entry.teamId,
            selfService: prior?.self_service ?? false,
            categories: prior?.categories ?? [],
            installScript: prior?.install_script ?? '',
            postInstallScript: prior?.post_install_script ?? '',
            preInstallQuery: prior?.pre_install_query ?? '',
          })
        } else {
          const prior = entry.priorAppStoreApp
          await updateAppStoreOverrides(base, headers, entry.priorTitleId, {
            teamId: entry.teamId,
            selfService: prior?.self_service ?? false,
            categories: prior?.categories ?? [],
            autoUpdateEnabled: prior?.auto_update_enabled ?? false,
            autoUpdateWindowStart: prior?.auto_update_window_start ?? '',
            autoUpdateWindowEnd: prior?.auto_update_window_end ?? '',
          })
        }
        restored++
      } else if (entry.createdTitleId !== undefined) {
        await deleteSoftwareTitle(base, headers, entry.createdTitleId, entry.teamId)
        removed++
      }
    }
    return { success: true, message: `Rolled back software: ${restored} restored, ${removed} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
