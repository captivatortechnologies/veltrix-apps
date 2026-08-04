import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_TRIGGER_MUTATION,
  LIST_NOTIFIERS_FOR_RESOLUTION_QUERY,
  LIST_TRIGGERS_QUERY,
  PATCH_TRIGGER_MUTATION,
  buildTriggerInput,
  buildTriggerPatch,
  findTrigger,
  notifierRefsFromList,
  resolveNotifierIds,
  toStringList,
  triggersFromList,
  type OpenctiTrigger,
} from './_shared'

/**
 * Deploy OpenCTI live knowledge triggers over the GraphQL API:
 *   read (rollback + resolution): triggers, notifiers → find the live trigger
 *     by name, and resolve each item's `notifier_names` into live Notifier ids
 *   create: triggerKnowledgeLiveAdd(input) with { name, event_types, instance_trigger, ... }
 *   update: triggerKnowledgeFieldPatch(id, input) with [EditInput] (trigger exists)
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per
 * trigger, the prior node (null when it did not exist) AND its id — so
 * rollback can restore the prior body (including its prior notifier/recipient
 * ids) or delete the one we created. A notifier name with no live match is
 * skipped (not a deploy failure) and reported back in the result message.
 */
async function listTriggers(base: string, headers: Record<string, string>): Promise<OpenctiTrigger[]> {
  try {
    return triggersFromList(await graphql<unknown>(base, headers, LIST_TRIGGERS_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for notification-trigger deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; triggerId: string | null; trigger: OpenctiTrigger | null }> = []
  const applied: string[] = []
  const allUnresolved: string[] = []

  try {
    const [live, liveNotifiers] = await Promise.all([
      listTriggers(base, headers),
      graphql<unknown>(base, headers, LIST_NOTIFIERS_FOR_RESOLUTION_QUERY).then(notifierRefsFromList).catch(() => []),
    ])

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const { ids: notifierIds, unresolved } = resolveNotifierIds(toStringList(item.fields.notifier_names), liveNotifiers)
      if (unresolved.length > 0) allUnresolved.push(...unresolved.map((n) => `${name}: "${n}"`))

      const existing = findTrigger(live, name)

      if (existing && existing.id != null) {
        await graphql(base, headers, PATCH_TRIGGER_MUTATION, { id: existing.id, input: buildTriggerPatch(item.fields, notifierIds) })
        previous.push({ name, triggerId: String(existing.id), trigger: existing })
      } else {
        const created = await graphql<{ triggerKnowledgeLiveAdd?: OpenctiTrigger }>(base, headers, ADD_TRIGGER_MUTATION, {
          input: buildTriggerInput(item.fields, notifierIds),
        })
        const newId = created?.triggerKnowledgeLiveAdd?.id ?? null
        previous.push({ name, triggerId: newId ? String(newId) : null, trigger: null })
      }
      applied.push(name)
    }

    const unresolvedNote = allUnresolved.length > 0 ? ` (unresolved notifier names, skipped: ${allUnresolved.join(', ')})` : ''
    return {
      success: true,
      message: `Applied ${applied.length} notification trigger(s): ${applied.join(', ') || '(none)'}${unresolvedNote}`,
      artifacts: { applied, unresolvedNotifierNames: allUnresolved },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Notification-trigger deploy failed after ${applied.length} trigger(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
