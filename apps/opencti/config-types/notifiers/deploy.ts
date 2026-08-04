import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_NOTIFIER_MUTATION,
  LIST_NOTIFIERS_QUERY,
  PATCH_NOTIFIER_MUTATION,
  buildNotifierInput,
  buildNotifierPatch,
  findNotifier,
  notifiersFromList,
  type OpenctiNotifier,
} from './_shared'

/**
 * Deploy OpenCTI notifiers over the GraphQL API:
 *   read (rollback): notifiers                → find the live notifier by name
 *   create:          notifierAdd(input) with { name, description?, notifier_connector_id, notifier_configuration }
 *   update:          notifierFieldPatch(id, input) with [EditInput] (notifier exists)
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per
 * notifier, the prior node (null when it did not exist) AND the id — so
 * rollback can restore the prior body or delete the one we created.
 *
 * NOTE: notifierAdd returns the created notifier (with its new id).
 */
async function listNotifiers(base: string, headers: Record<string, string>): Promise<OpenctiNotifier[]> {
  try {
    return notifiersFromList(await graphql<unknown>(base, headers, LIST_NOTIFIERS_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for notifier deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; notifierId: string | null; notifier: OpenctiNotifier | null }> = []
  const applied: string[] = []

  try {
    const live = await listNotifiers(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findNotifier(live, name)

      if (existing && existing.id != null) {
        await graphql(base, headers, PATCH_NOTIFIER_MUTATION, { id: existing.id, input: buildNotifierPatch(item.fields) })
        previous.push({ name, notifierId: String(existing.id), notifier: existing })
      } else {
        const created = await graphql<{ notifierAdd?: OpenctiNotifier }>(base, headers, ADD_NOTIFIER_MUTATION, {
          input: buildNotifierInput(item.fields),
        })
        const newId = created?.notifierAdd?.id ?? null
        previous.push({ name, notifierId: newId ? String(newId) : null, notifier: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} notifier(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Notifier deploy failed after ${applied.length} notifier(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
