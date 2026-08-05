import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import {
  createAllowedItem,
  deleteAllowedItem,
  listAllowedItems,
  updateAllowedItem,
  type SophosAllowedItem,
} from '../../lib/sophosApi'
import { allowedItemKey, allowedItemPropertiesMatch, buildAllowedItemBody, extractAllowedItemSpecs, liveAllowedItemValue } from './_shared'

export interface AllowedItemRollbackEntry {
  key: string
  action: 'created' | 'patched' | 'replaced' | 'unchanged'
  newId?: string
  priorComment?: string
  prior?: Pick<SophosAllowedItem, 'type' | 'properties' | 'comment'>
}

/**
 * Deploy Sophos Central allowed items, reconciled by (type, value):
 *   create:  POST  /settings/allowed-items                          when no live item matches
 *   patch:   PATCH /settings/allowed-items/{id}                      when only `comment` differs (the only patchable field)
 *   replace: DELETE then POST                                        when properties (fileName) differ
 *   no-op:   nothing                                                  when the live item already matches exactly
 *
 * The live list is read once and reused across every declared item.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractAllowedItemSpecs(ctx.canvas).filter((s) => s.type && s.value && s.comment)
  const previous: AllowedItemRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const live = await listAllowedItems(client)
    const liveByKey = new Map(
      live
        .map((i) => [i.type && liveAllowedItemValue(i) ? allowedItemKey(i.type, liveAllowedItemValue(i)!) : null, i] as const)
        .filter((entry): entry is [string, SophosAllowedItem] => entry[0] !== null),
    )

    for (const spec of specs) {
      const key = allowedItemKey(spec.type, spec.value)
      const match = liveByKey.get(key)
      const label = `${spec.type}:${spec.value}`

      if (!match) {
        const created = await createAllowedItem(client, buildAllowedItemBody(spec))
        previous.push({ key, action: 'created', newId: created.id })
      } else if (allowedItemPropertiesMatch(spec, match)) {
        if ((match.comment ?? '') !== spec.comment && match.id) {
          await updateAllowedItem(client, match.id, spec.comment)
          previous.push({ key, action: 'patched', newId: match.id, priorComment: match.comment })
        } else {
          previous.push({ key, action: 'unchanged' })
        }
      } else {
        if (match.id) await deleteAllowedItem(client, match.id)
        const created = await createAllowedItem(client, buildAllowedItemBody(spec))
        previous.push({
          key,
          action: 'replaced',
          newId: created.id,
          prior: { type: match.type, properties: match.properties, comment: match.comment },
        })
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} allowed item(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Allowed item deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
