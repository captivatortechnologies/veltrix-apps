import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import { resourceToBody, scopeToBody } from './_shared'
import type { ResourceRollbackEntry } from './deploy'

/**
 * Roll back Resources + Scopes using the state captured during deploy. An
 * entry marked `protected: true` (a built-in resource deploy never touched)
 * is always skipped entirely - there is nothing to revert.
 *
 * For a resource this deploy CREATED: its scopes (all created alongside it)
 * are deleted first, then the resource itself is deleted.
 * For a resource that EXISTED before this deploy, in order:
 *   1. any scope this deploy DELETED (pruned) is RE-CREATED (POST) under the
 *      same resource from its captured prior body - PingOne assigns it a new
 *      id, the original id cannot be restored.
 *   2. each scope this deploy created-or-updated is undone - a CREATED scope
 *      is deleted; an UPDATED scope is restored (PUT) to its prior body.
 *   3. the resource's own attributes are restored (PUT).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ResourceRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const skippedProtected: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (entry.protected) {
        skippedProtected.push(entry.name)
        continue
      }
      if (!entry.id) {
        reverted.push(entry.name)
        continue
      }

      if (!entry.existed) {
        for (const scopeEntry of entry.scopeRollback.updated) {
          if (!scopeEntry.id) continue
          const res = await client.request('DELETE', `/resources/${entry.id}/scopes/${encodeURIComponent(scopeEntry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete scope on resource "${entry.name}": ${pingOneErrorMessage(res)}`)
          }
        }
        const res = await client.request('DELETE', `/resources/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete resource "${entry.name}": ${pingOneErrorMessage(res)}`)
        }
      } else {
        for (const deletedScope of entry.scopeRollback.deleted) {
          const body = scopeToBody(deletedScope.priorBody)
          const res = await client.request('POST', `/resources/${entry.id}/scopes`, { body })
          if (!res.ok) {
            throw new Error(`Failed to recreate pruned scope on resource "${entry.name}": ${pingOneErrorMessage(res)}`)
          }
        }

        for (const scopeEntry of entry.scopeRollback.updated) {
          if (!scopeEntry.existed) {
            if (scopeEntry.id) {
              const res = await client.request('DELETE', `/resources/${entry.id}/scopes/${encodeURIComponent(scopeEntry.id)}`)
              if (res.status !== 404 && !res.ok) {
                throw new Error(`Failed to delete scope on resource "${entry.name}": ${pingOneErrorMessage(res)}`)
              }
            }
          } else if (scopeEntry.id && scopeEntry.prior) {
            const body = scopeToBody(scopeEntry.prior)
            const res = await client.request('PUT', `/resources/${entry.id}/scopes/${encodeURIComponent(scopeEntry.id)}`, { body })
            if (!res.ok) throw new Error(`Failed to restore scope on resource "${entry.name}": ${pingOneErrorMessage(res)}`)
          }
        }

        if (entry.prior) {
          const body = resourceToBody(entry.prior)
          const res = await client.request('PUT', `/resources/${encodeURIComponent(entry.id)}`, { body })
          if (!res.ok) throw new Error(`Failed to restore resource "${entry.name}": ${pingOneErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    const protectedNote = skippedProtected.length
      ? ` (${skippedProtected.length} built-in/protected resource(s) left untouched: ${skippedProtected.join(', ')})`
      : ''

    return {
      success: true,
      message: `Rolled back ${reverted.length} Resource(s): ${reverted.join(', ')}${protectedNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length - skippedProtected.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
