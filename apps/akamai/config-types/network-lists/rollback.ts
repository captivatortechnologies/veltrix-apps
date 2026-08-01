import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, NETWORK_LISTS_PATH, parseJson, type AkamaiClient } from '../../lib/akamaiApi'
import type { NetworkList } from './_shared'

/**
 * Undo a Network Lists deploy from rollbackData.previous (written by deploy()):
 *   - a list that PRE-EXISTED → PUT its prior body back (name/type/description/
 *     elements), using the list's CURRENT syncPoint (re-read, since our deploy
 *     bumped it).
 *   - a list we CREATED (prior === null) → DELETE it (safe: v0.1.0 never
 *     activates a list, and Akamai only allows deleting never-activated lists).
 *
 * Applied over the Network Lists API v2 (EdgeGrid-signed, HTTPS 443).
 */

interface PriorEntry {
  name: string
  uniqueId: string | null
  prior: { name: string; type: string; description: string; list: string[] } | null
}

/** Re-read a list's current syncPoint (required for a PUT restore). */
async function currentSyncPoint(client: AkamaiClient, uniqueId: string): Promise<number> {
  const res = await client.request('GET', `${NETWORK_LISTS_PATH}/${encodeURIComponent(uniqueId)}`, {
    query: { includeElements: false },
  })
  if (!res.ok) throw new Error(`GET "${uniqueId}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  return parseJson<NetworkList>(res.body)?.syncPoint ?? 0
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
      if (!entry.uniqueId) {
        // A created list whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (entry.prior) {
        const syncPoint = await currentSyncPoint(client, entry.uniqueId)
        const body = {
          name: entry.prior.name,
          type: entry.prior.type,
          description: entry.prior.description,
          list: entry.prior.list,
          syncPoint,
        }
        const res = await client.request('PUT', `${NETWORK_LISTS_PATH}/${encodeURIComponent(entry.uniqueId)}`, { body })
        if (!res.ok) throw new Error(`PUT "${entry.name}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        restored++
      } else {
        const res = await client.request('DELETE', `${NETWORK_LISTS_PATH}/${encodeURIComponent(entry.uniqueId)}`)
        if (!res.ok && res.status !== 404) throw new Error(`DELETE "${entry.name}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back network lists: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
