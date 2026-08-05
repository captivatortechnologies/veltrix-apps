import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { IdentityAliasRollbackEntry } from './deploy'
import { aliasKey } from './validate'

/**
 * Roll back identity aliases using the state captured during deploy:
 *   - aliases this deploy CREATED are deleted (DELETE /identity/{kind}-alias/id/{id})
 *   - aliases this deploy UPDATED are restored to their prior canonical_id
 *     (POST /identity/{kind}-alias/id/{id}), re-pointing them at the entity or
 *     group they belonged to before this deploy ran.
 *
 * DELETING AN ALIAS BREAKS LOGIN MAPPING for that external identity — the next
 * time that user/service authenticates through the mount, Vault will no longer
 * resolve them to the entity/group the alias pointed at (a new alias, and
 * possibly a new entity, is auto-created on next login instead). Rollback only
 * ever deletes aliases DEPLOY ITSELF CREATED, never a pre-existing one.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IdentityAliasRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const deleted: string[] = []

  try {
    for (const entry of previousState) {
      const key = aliasKey(entry.kind, entry.mountAccessor, entry.name)

      if (!entry.existed) {
        // Deploy CREATED this alias — delete it. 404 means it is already gone,
        // which is the desired end state.
        if (entry.aliasId) {
          const res = await client.request('DELETE', `/identity/${entry.kind}-alias/id/${entry.aliasId}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete ${entry.kind} alias "${key}": ${vaultErrorMessage(res)}`)
          }
          deleted.push(key)
        }
      } else if (entry.aliasId && entry.priorCanonicalId) {
        // Deploy UPDATED this alias — restore the prior canonical_id (name and
        // mount_accessor are the reconciliation key and never change).
        const res = await client.request('POST', `/identity/${entry.kind}-alias/id/${entry.aliasId}`, {
          body: { name: entry.name, canonical_id: entry.priorCanonicalId, mount_accessor: entry.mountAccessor },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore ${entry.kind} alias "${key}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(key)
    }

    const deleteNote = deleted.length
      ? ` WARNING: deleted ${deleted.length} newly-created alias(es) (${deleted.join(', ')}) — the next login through that mount will no longer resolve to the entity/group it pointed at.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} identity alias(es): ${reverted.join(', ')}.${deleteNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} alias(es): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
