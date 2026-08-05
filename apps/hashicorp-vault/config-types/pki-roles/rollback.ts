import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { PkiRoleRollbackEntry } from './deploy'
import { roleKey } from './validate'

/**
 * Roll back PKI roles using the state captured during deploy:
 *   - roles this deploy CREATED are deleted (DELETE {mount}/roles/{name})
 *   - roles this deploy UPDATED are restored from the COMPLETE prior role
 *     object captured before the write (POST {mount}/roles/{name}) — necessary
 *     because a role write fully replaces the role (see deploy.ts), so a
 *     partial restore would leave fields at whatever this deploy set them to.
 *
 * Deleting a role does NOT revoke or affect certificates already issued under
 * it — only future `issue`/`sign` calls against that role name fail. Rollback
 * only ever deletes roles DEPLOY ITSELF CREATED, never a pre-existing one.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PkiRoleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const deleted: string[] = []

  try {
    for (const entry of previousState) {
      const key = roleKey(entry.mount, entry.name)

      if (!entry.existed) {
        // Deploy CREATED this role — delete it. 404 means it is already gone,
        // which is the desired end state.
        const res = await client.request('DELETE', `/${entry.mount}/roles/${entry.name}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete PKI role "${key}": ${vaultErrorMessage(res)}`)
        }
        deleted.push(key)
      } else if (entry.priorBody) {
        // Deploy UPDATED this role — restore the COMPLETE prior object.
        const res = await client.request('POST', `/${entry.mount}/roles/${entry.name}`, { body: entry.priorBody })
        if (!res.ok) {
          throw new Error(`Failed to restore PKI role "${key}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(key)
    }

    const deleteNote = deleted.length
      ? ` Deleted ${deleted.length} newly-created role(s) (${deleted.join(', ')}) — certificates already issued under them are unaffected.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} PKI role(s): ${reverted.join(', ')}.${deleteNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
