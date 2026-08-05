import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { createBlockedItem, deleteBlockedItem, listBlockedItems, type SophosBlockedItem } from '../../lib/sophosApi'
import { blockedItemKey, blockedItemMatches, buildBlockedItemBody, extractBlockedItemSpecs } from './_shared'

export interface BlockedItemRollbackEntry {
  sha256: string
  action: 'created' | 'replaced' | 'unchanged'
  newId?: string
  prior?: { properties: SophosBlockedItem['properties']; comment: string }
}

/**
 * Deploy Sophos Central blocked items, reconciled by SHA256:
 *   create: POST /settings/blocked-items                       when no live item has this hash
 *   replace: DELETE then POST                                    when the hash exists but fileName/path/comment differ (no PATCH exists)
 *   no-op:   nothing                                              when the live item already matches
 *
 * The live list is read once and reused across every declared item.
 * rollbackData records, per item, what changed so rollback can undo it.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractBlockedItemSpecs(ctx.canvas).filter((s) => s.sha256 && s.comment)
  const previous: BlockedItemRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const live = await listBlockedItems(client)
    const liveByHash = new Map(live.filter((i) => i.properties?.sha256).map((i) => [blockedItemKey(i.properties.sha256), i]))

    for (const spec of specs) {
      const key = blockedItemKey(spec.sha256)
      const match = liveByHash.get(key)

      if (!match) {
        const created = await createBlockedItem(client, buildBlockedItemBody(spec))
        previous.push({ sha256: spec.sha256, action: 'created', newId: created.id })
      } else if (blockedItemMatches(spec, match)) {
        previous.push({ sha256: spec.sha256, action: 'unchanged' })
      } else {
        if (match.id) await deleteBlockedItem(client, match.id)
        const created = await createBlockedItem(client, buildBlockedItemBody(spec))
        previous.push({
          sha256: spec.sha256,
          action: 'replaced',
          newId: created.id,
          prior: { properties: match.properties, comment: match.comment },
        })
      }
      deployed.push(spec.sha256)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} blocked item(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Blocked item deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
