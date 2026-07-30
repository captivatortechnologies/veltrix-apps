import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { buildSharingGroupFields, sharingGroupsFromList, findSharingGroup, type MispSharingGroup } from './_shared'

/**
 * Deploy MISP sharing groups over the REST API (443):
 *   read (rollback): GET  /sharing_groups          → find the live group by name
 *   create:          POST /sharing_groups/add       with { SharingGroup: {...} }
 *   update:          POST /sharing_groups/edit/<id>  with { SharingGroup: {...} } (group exists)
 *
 * The name is the stable identity used to upsert. rollbackData records, per group,
 * the prior group body (null when it did not exist) AND the group id — so rollback
 * can restore the prior body, or leave a newly created group in place (MISP has no
 * simple delete over this seam).
 *
 * NOTE: verify /sharing_groups + /sharing_groups/add + /sharing_groups/edit/<id>
 * against a live MISP 2.4 instance.
 */
interface SharingGroupMutationResponse {
  SharingGroup?: MispSharingGroup
}

async function listSharingGroups(base: string, headers: Record<string, string>): Promise<MispSharingGroup[]> {
  try {
    return sharingGroupsFromList(await getJson<unknown>(`${base}/sharing_groups`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for sharing group deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; groupId: number | string | null; group: MispSharingGroup | null }> = []
  const applied: string[] = []

  try {
    const live = await listSharingGroups(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findSharingGroup(live, name)
      const body = { SharingGroup: buildSharingGroupFields(item.fields) }

      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/sharing_groups/edit/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, groupId: existing.id, group: existing })
      } else {
        const created = await sendJson<SharingGroupMutationResponse>('POST', `${base}/sharing_groups/add`, headers, body)
        const newId = created?.SharingGroup?.id ?? null
        previous.push({ name, groupId: newId, group: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} sharing group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sharing group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
