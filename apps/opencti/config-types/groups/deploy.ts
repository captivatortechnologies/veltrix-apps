import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_GROUP_MUTATION,
  LIST_GROUPS_QUERY,
  PATCH_GROUP_MUTATION,
  buildGroupInput,
  buildGroupPatch,
  findGroup,
  groupsFromList,
  type OpenctiGroup,
} from './_shared'

/**
 * Deploy OpenCTI RBAC groups over the GraphQL API:
 *   read (rollback): groups                      → find the live group by name
 *   create:          groupAdd(input) with { name, description?, default_assignation?, auto_new_marking? }
 *   update:          groupEdit(id) { fieldPatch(input) } with [EditInput] (group exists)
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per group,
 * the prior group node (null when it did not exist) AND the group id — so rollback
 * can restore the prior body or delete the one we created.
 *
 * NOTE: groupAdd returns the created group (with its new id). Verify the operation
 * names (groupEdit vs groupFieldPatch) + field shapes against a live OpenCTI instance.
 */
async function listGroups(base: string, headers: Record<string, string>): Promise<OpenctiGroup[]> {
  try {
    return groupsFromList(await graphql<unknown>(base, headers, LIST_GROUPS_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for group deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; groupId: string | null; group: OpenctiGroup | null }> = []
  const applied: string[] = []

  try {
    const live = await listGroups(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findGroup(live, name)

      if (existing && existing.id != null) {
        const input = buildGroupPatch(item.fields)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_GROUP_MUTATION, { id: existing.id, input })
        }
        previous.push({ name, groupId: String(existing.id), group: existing })
      } else {
        const created = await graphql<{ groupAdd?: OpenctiGroup }>(base, headers, ADD_GROUP_MUTATION, {
          input: buildGroupInput(item.fields),
        })
        const newId = created?.groupAdd?.id ?? null
        previous.push({ name, groupId: newId ? String(newId) : null, group: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
