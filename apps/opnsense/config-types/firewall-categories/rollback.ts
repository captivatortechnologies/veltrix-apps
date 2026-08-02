import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpnsenseClient, deleteCategory, searchCategories, setCategory, type CategoryBody, type LiveCategory } from '../../lib/opnsenseApi'
import { categoryKey, isSystemManaged } from './_shared'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  uuid?: string
  prior?: CategoryBody
}

/**
 * Roll back OPNsense firewall categories using the state deploy captured:
 * created categories (existed: false) are removed; updated categories
 * (existed: true) are restored to their prior body. Re-finds each category
 * by its CURRENT name via searchItem. No apply step — categories have no
 * live pf effect (see deploy.ts's module doc).
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
    const live = await searchCategories(client)
    const liveByName = new Map<string, LiveCategory>(
      live.filter((c) => !isSystemManaged(c) && c.name).map((c) => [categoryKey(c.name as string), c]),
    )

    for (const entry of [...entries].reverse()) {
      const found = liveByName.get(categoryKey(entry.name))

      if (entry.existed && entry.prior) {
        if (!found) {
          skipped++
          continue
        }
        await setCategory(client, found.uuid, entry.prior)
        restored++
      } else if (!entry.existed) {
        if (!found) {
          skipped++
          continue
        }
        await deleteCategory(client, found.uuid)
        removed++
      }
    }

    return {
      success: true,
      message:
        `Rolled back ${entries.length} OPNsense firewall categor${entries.length === 1 ? 'y' : 'ies'}: ${removed} removed, ${restored} restored` +
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
