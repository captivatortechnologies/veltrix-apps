import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient, deployToDevicesIfEnabled, fmcErrorMessage } from '../../lib/fmc'
import type { NetworkObjectRollbackEntry } from './deploy'

/** Delete (by id, at the entry's own path) only the network objects this deploy created. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, settings } = built

  const data = (ctx.rollbackData as { rollback?: NetworkObjectRollbackEntry[] }) ?? {}
  const rollback = data.rollback ?? []
  const created = rollback.filter((r) => !r.existed)
  const preExisting = rollback.filter((r) => r.existed)
  const deleted: string[] = []

  try {
    for (const entry of [...created].reverse()) {
      const res = await client.deleteObject(entry.path, entry.id)
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to delete "${entry.name}": ${fmcErrorMessage(res)}`)
      }
      deleted.push(entry.name)
    }
    const activation = await deployToDevicesIfEnabled(client, settings)
    const kept = preExisting.length ? ` Left ${preExisting.length} pre-existing network object(s) unchanged.` : ''
    return { success: true, message: `Rolled back ${deleted.length} created network object(s).${kept} ${activation.message}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after deleting ${deleted.length} of ${created.length} created network object(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
