import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { buildPackageBody, type LivePackage } from './validate'
import type { PackageRollbackEntry } from './deploy'

const PACKAGES_PATH = '/v1/packages'

/**
 * Roll back Jamf Pro package records using the state captured during deploy:
 *   - packages that were created are deleted (DELETE /v1/packages/{id})
 *   - packages that were updated are restored to their captured prior state
 *     (PUT /v1/packages/{id}) — reusing the prior record's own categoryId
 *     directly (no name re-resolution needed for a restore).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PackageRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${PACKAGES_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete package "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PUT', `${PACKAGES_PATH}/${encodeURIComponent(entry.id)}`, priorToBody(entry.prior))
        if (res.error) throw new Error(`Failed to restore package "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }
    return { success: true, message: `Rolled back ${reverted.length} Jamf Pro package(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild an update body straight from the prior live record — categoryId is already resolved, no name lookup needed. */
function priorToBody(prior: LivePackage): Record<string, unknown> {
  return buildPackageBody(
    {
      sectionName: '',
      name: prior.packageName ?? '',
      fileName: prior.fileName ?? '',
      categoryName: '',
      priority: prior.priority ?? 10,
      info: prior.info ?? '',
      notes: prior.notes ?? '',
      osRequirements: prior.osRequirements ?? '',
      fillUserTemplate: prior.fillUserTemplate ?? false,
      fillExistingUsers: prior.fillExistingUsers ?? false,
      rebootRequired: prior.rebootRequired ?? false,
      osInstall: prior.osInstall ?? false,
      suppressUpdates: prior.suppressUpdates ?? false,
      suppressFromDock: prior.suppressFromDock ?? false,
      suppressEula: prior.suppressEula ?? false,
      suppressRegistration: prior.suppressRegistration ?? false,
      ignoreConflicts: prior.ignoreConflicts ?? false,
      installLanguage: prior.installLanguage ?? '',
    },
    prior.categoryId ?? '-1',
  )
}
