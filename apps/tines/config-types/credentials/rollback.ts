import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import type { CredentialRollbackEntry } from './deploy'

/**
 * Undo a Credentials deploy from rollbackData.previousState (written by
 * deploy()), in reverse order:
 *   - a credential that was CREATED is deleted (DELETE /api/v1/user_credentials/{id})
 *   - a credential that was UPDATED is restored (PUT) to its prior NON-SECRET
 *     fields only — Tines never returned its secret material in the first
 *     place, so there is nothing to restore there; the credential's secret
 *     value (if the deploy changed it) is left as whatever was last written.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: CredentialRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/user_credentials/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete credential "${entry.name}": ${tinesErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const body: Record<string, unknown> = {
          name: String(entry.prior.name ?? entry.name),
          mode: entry.prior.mode,
          read_access: entry.prior.read_access ?? 'TEAM',
        }
        if (entry.prior.description) body.description = entry.prior.description
        if (entry.prior.metadata) body.metadata = entry.prior.metadata
        if (entry.prior.allowed_hosts) body.allowed_hosts = entry.prior.allowed_hosts
        if (entry.prior.folder_id) body.folder_id = entry.prior.folder_id
        if (entry.prior.expires_at) body.expires_at = entry.prior.expires_at
        if (entry.prior.expiry_notifications_enabled !== undefined) {
          body.expiry_notifications_enabled = entry.prior.expiry_notifications_enabled
        }
        if (entry.prior.shared_team_slugs) body.shared_team_slugs = entry.prior.shared_team_slugs
        const res = await client.request('PUT', `/user_credentials/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore credential "${entry.name}": ${tinesErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} credential(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
