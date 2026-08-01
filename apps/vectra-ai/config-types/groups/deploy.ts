import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson, sendJson } from '../../lib/vectraApi'
import { buildGroupBody, buildGroupUpdateBody, groupsFromList, findGroup, type VectraGroup } from './_shared'

/**
 * Deploy Vectra groups over the Detect REST API (v2.5, 443):
 *   read (rollback): GET   /groups            → find the live group by name
 *   create:          POST  /groups            body { name, description, type, members }
 *   update:          PATCH /groups/{id}        body { name, description, members }
 *
 * The group name is the stable identity used to upsert. rollbackData records, per
 * group, the prior group body (null when it did not exist) AND the group id — so
 * rollback can restore the prior body or delete the one we created.
 *
 * NOTE: Vectra returns the created/updated group (with its id) from /groups. Some
 * builds wrap it in a `{ group: {...} }` envelope — both shapes are handled. Verify
 * against a live Vectra brain.
 */
interface GroupMutationResponse extends VectraGroup {
  group?: VectraGroup
}

/** Pull the group id out of a create/update response (bare object or {group} wrapper). */
function idOf(res: GroupMutationResponse | null): number | string | null {
  return res?.id ?? res?.group?.id ?? null
}

/** Read every live group (best-effort) for identity matching + rollback snapshots. */
async function listGroups(base: string, headers: Record<string, string>): Promise<VectraGroup[]> {
  try {
    return groupsFromList(await getJson<unknown>(`${base}/groups?page_size=5000`, headers))
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

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; groupId: number | string | null; group: VectraGroup | null }> = []
  const applied: string[] = []

  try {
    const live = await listGroups(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findGroup(live, name)

      if (existing && existing.id != null) {
        await sendJson('PATCH', `${base}/groups/${encodeURIComponent(String(existing.id))}`, headers, buildGroupUpdateBody(item.fields))
        previous.push({ name, groupId: existing.id, group: existing })
      } else {
        const created = await sendJson<GroupMutationResponse>('POST', `${base}/groups`, headers, buildGroupBody(item.fields))
        previous.push({ name, groupId: idOf(created), group: null })
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
