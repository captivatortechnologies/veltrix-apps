import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import { buildMetadataPatch, getNamespace } from './deploy'
import type { NamespaceRollbackEntry } from './deploy'

/**
 * Roll back namespaces using the state captured during deploy:
 *   - namespaces this deploy CREATED are deleted (DELETE /sys/namespaces/{path})
 *   - namespaces this deploy UPDATED have their custom_metadata restored to
 *     the prior snapshot (PATCH /sys/namespaces/{path})
 *
 * DELETING A NAMESPACE PERMANENTLY DESTROYS EVERYTHING INSIDE IT — every
 * secret, mount, policy, auth method, identity object and child namespace it
 * contains. Rollback only ever deletes a namespace THIS deploy created — never
 * a pre-existing one — and the result message says plainly that this is
 * destructive to anything provisioned inside it since.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: NamespaceRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const destroyed: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy CREATED this namespace — delete it. 404 means it is already
        // gone, which is the desired end state.
        const res = await client.request('DELETE', `/sys/namespaces/${entry.path}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete namespace "${entry.path}": ${vaultErrorMessage(res)}`)
        }
        destroyed.push(entry.path)
      } else if (entry.priorCustomMetadata) {
        // Deploy UPDATED this namespace — restore custom_metadata to the prior
        // snapshot. Re-read the CURRENT metadata first so the patch correctly
        // nulls out anything the deploy added that was not there before.
        const current = await getNamespace(client, entry.path)
        const currentMetadata = current?.custom_metadata ?? {}
        const patch = buildMetadataPatch(entry.priorCustomMetadata, currentMetadata)
        if (Object.keys(patch).length > 0) {
          const res = await client.request('PATCH', `/sys/namespaces/${entry.path}`, {
            body: { custom_metadata: patch },
          })
          if (!res.ok) {
            throw new Error(`Failed to restore namespace "${entry.path}": ${vaultErrorMessage(res)}`)
          }
        }
      }

      reverted.push(entry.path)
    }

    const destroyNote = destroyed.length
      ? ` WARNING: deleted ${destroyed.length} newly-created namespace(s) (${destroyed.join(', ')}) — this PERMANENTLY DESTROYS every mount, policy, auth method and secret provisioned inside them since.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} namespace(s): ${reverted.join(', ')}.${destroyNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} namespace(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
