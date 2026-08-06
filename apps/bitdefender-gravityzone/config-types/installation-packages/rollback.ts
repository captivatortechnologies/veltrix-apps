import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { deletePackage, updatePackage, type GzPackage } from '../../lib/gravityZoneApi'
import { findLivePackage, listAllPackages, livePackageId } from './_shared'
import type { InstallationPackageRollbackEntry } from './deploy'

/**
 * Roll back installation packages using the state captured during deploy:
 *   - packages this deploy CREATED are deleted (packages.deletePackage)
 *   - packages this deploy UPDATED are restored to their prior full object
 *     (packages.updatePackage)
 *   - unchanged packages are left alone
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: InstallationPackageRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    let live: GzPackage[] | null = null
    for (const entry of [...previous].reverse()) {
      if (entry.action === 'created') {
        if (!live) live = await listAllPackages(client)
        const match = findLivePackage(live, entry.packageName)
        if (match) await deletePackage(client, livePackageId(match))
      } else if (entry.action === 'updated' && entry.prior) {
        if (!live) live = await listAllPackages(client)
        const match = findLivePackage(live, entry.packageName)
        if (match) await updatePackage(client, livePackageId(match), entry.prior)
      }
      reverted.push(entry.packageName)
    }
    return { success: true, message: `Rolled back ${reverted.length} installation package(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
