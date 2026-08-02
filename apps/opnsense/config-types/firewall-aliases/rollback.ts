import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpnsenseClient, deleteAlias, reconfigureAliases, searchAliases, setAlias, type AliasBody, type LiveAlias } from '../../lib/opnsenseApi'
import { aliasKey } from './_shared'

export interface RollbackEntry {
  itemId?: string
  /** name is the identity OPNsense aliases are matched on. */
  name: string
  /** Whether the alias existed before THIS deploy touched it — setItem (true) vs addItem (false). */
  existed: boolean
  /** The uuid addItem returned, when this deploy created the alias. */
  uuid?: string
  /** Prior body, captured before an update, so rollback can restore it. */
  prior?: AliasBody
}

/**
 * Roll back OPNsense firewall aliases using the state deploy captured:
 *   - aliases that were CREATED (existed: false) are removed (delItem)
 *   - aliases that were UPDATED (existed: true) are restored to their prior
 *     body (setItem)
 * Applied in reverse deploy order. Each alias is re-found by its CURRENT
 * name via searchItem rather than trusting a possibly-stale captured uuid —
 * an intervening manual edit could have changed it. Exactly like deploy,
 * every delItem/setItem call here only STAGES the reversal; reconfigure runs
 * once at the end, over everything this rollback touched, to actually apply it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const entries = (ctx.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries
  if (!entries || entries.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let removed = 0
  let skipped = 0

  try {
    const live = await searchAliases(client)
    const liveByName = new Map<string, LiveAlias>(live.filter((a) => a.name).map((a) => [aliasKey(a.name as string), a]))

    for (const entry of [...entries].reverse()) {
      const found = liveByName.get(aliasKey(entry.name))

      if (entry.existed && entry.prior) {
        if (!found) {
          skipped++ // it was removed by hand since this deploy — nothing to restore onto
          continue
        }
        await setAlias(client, found.uuid, entry.prior)
        restored++
      } else if (!entry.existed) {
        if (!found) {
          skipped++ // already gone
          continue
        }
        await deleteAlias(client, found.uuid)
        removed++
      }
    }

    if (restored + removed > 0) {
      await reconfigureAliases(client)
    }

    return {
      success: true,
      message:
        `Rolled back ${entries.length} OPNsense alias(es): ${removed} removed, ${restored} restored` +
        `${skipped ? `, ${skipped} skipped (already changed outside this app)` : ''}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${removed} removed, ${restored} restored: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
