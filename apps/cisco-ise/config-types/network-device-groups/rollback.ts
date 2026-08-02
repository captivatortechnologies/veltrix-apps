import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildErsResourceClient,
  readIseSettings,
  hasUsableCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type NetworkDeviceGroup,
} from '../../lib/iseApi'
import { toNetworkDeviceGroupBody } from './_shared'
import type { RollbackEntry } from './deploy'

/**
 * Undo a network-device-groups deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT the prior name/description back (restore), or
 * — when the group was newly created (prior detail null) — DELETE it. Applied
 * over the ISE ERS API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<NetworkDeviceGroup>(base, 'networkdevicegroup', 'NetworkDeviceGroup', credential, settings)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.id) {
        skipped++
        continue
      }
      if (entry.group) {
        await client.update(
          entry.id,
          toNetworkDeviceGroupBody({ name: entry.group.name ?? entry.name, description: entry.group.description ?? '' }),
        )
        restored++
      } else {
        await client.remove(entry.id)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back network device groups: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
