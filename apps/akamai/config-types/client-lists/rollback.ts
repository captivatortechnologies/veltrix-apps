import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, CLIENT_LISTS_PATH, parseJson, type AkamaiClient } from '../../lib/akamaiApi'
import { diffValues, toItemPayload, valuesFromList, type ClientList } from './_shared'

/**
 * Undo a Client Lists deploy from rollbackData.previous (written by deploy()):
 *   - a list that PRE-EXISTED → PUT its prior details back (name/notes/tags) and
 *     reconcile entries back to their prior values (full replace via the batch
 *     items endpoint), re-reading current entries first.
 *   - a list we CREATED (prior === null) → DELETE it (safe: content-only deploy
 *     never activates a list, and an inactive list can be deleted).
 *
 * Applied over the Client Lists API v1 (EdgeGrid-signed, HTTPS 443).
 */

interface PriorEntry {
  name: string
  listId: string | null
  prior: { name: string; notes: string; tags: string[]; values: string[] } | null
}

/** Re-read a single list's current entry values (needed to diff back to prior). */
async function currentValues(client: AkamaiClient, listId: string): Promise<string[]> {
  const res = await client.request('GET', `${CLIENT_LISTS_PATH}/${encodeURIComponent(listId)}`, {
    query: { includeItems: true },
  })
  if (!res.ok) throw new Error(`GET "${listId}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  const list = parseJson<ClientList>(res.body)
  return list ? valuesFromList(list) : []
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.listId) {
        skipped++
        continue
      }
      if (entry.prior) {
        const detailsBody = { name: entry.prior.name, notes: entry.prior.notes, tags: entry.prior.tags }
        const res = await client.request('PUT', `${CLIENT_LISTS_PATH}/${encodeURIComponent(entry.listId)}`, { body: detailsBody })
        if (!res.ok) throw new Error(`PUT "${entry.name}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)

        const current = await currentValues(client, entry.listId)
        const { append, remove } = diffValues(entry.prior.values, current)
        if (append.length || remove.length) {
          const itemsBody = { append: toItemPayload(append), update: [], delete: toItemPayload(remove) }
          const ir = await client.request('POST', `${CLIENT_LISTS_PATH}/${encodeURIComponent(entry.listId)}/items`, { body: itemsBody })
          if (!ir.ok) throw new Error(`restore entries "${entry.name}" → HTTP ${ir.status}: ${ir.body.slice(0, 200)}`)
        }
        restored++
      } else {
        const res = await client.request('DELETE', `${CLIENT_LISTS_PATH}/${encodeURIComponent(entry.listId)}`)
        if (!res.ok && res.status !== 404) throw new Error(`DELETE "${entry.name}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back client lists: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
