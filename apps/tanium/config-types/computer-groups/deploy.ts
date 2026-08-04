import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTaniumBaseUrl, resolveTaniumSession, getJson, sendJson } from '../../lib/taniumApi'
import { buildGroupBody, groupModeOf, createResourceFor, groupsFromList, groupFromResponse, findGroup, type TaniumGroup } from './_shared'

/**
 * Deploy Tanium computer groups over the REST v2 API (443). Two authoring modes,
 * both landing in the SAME `/api/v2/groups` collection for read/update/delete:
 *   read (rollback): GET   /api/v2/groups                    → find the live group by name
 *   create (filter): POST  /api/v2/groups                    with { name, text, filters? }
 *   create (manual): POST  /api/v2/computer_groups            with { name, computer_specs }
 *   update (either): PUT   /api/v2/groups/{id}                with the mode's body
 *
 * The name is the stable identity used to upsert. rollbackData records, per group,
 * the prior group body (null when it did not exist) AND the group id — so rollback
 * can restore the prior body, or delete a group this deploy created.
 *
 * VERIFY AGAINST A LIVE TANIUM: PUT /api/v2/groups/{id} as an in-place update (for
 * either mode) is a REST v2 convention not exercised by Tanium's public
 * integrations (which delete + recreate). Verify update semantics before relying
 * on it in production.
 */
async function listGroups(base: string, session: string): Promise<TaniumGroup[]> {
  try {
    return groupsFromList(await getJson<unknown>(`${base}/groups`, session))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for computer-group deployment' }
  }

  const base = buildTaniumBaseUrl(component, connectivity, connectivityProvider)

  const previous: Array<{ name: string; groupId: number | string | null; group: TaniumGroup | null }> = []
  const applied: string[] = []

  try {
    const session = await resolveTaniumSession(base, credential)
    const live = await listGroups(base, session)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findGroup(live, name)
      const body = buildGroupBody(item.fields)
      const resource = createResourceFor(groupModeOf(item.fields))

      if (existing && existing.id != null) {
        await sendJson('PUT', `${base}/groups/${encodeURIComponent(String(existing.id))}`, session, body)
        previous.push({ name, groupId: existing.id, group: existing })
      } else {
        const created = groupFromResponse(await sendJson<unknown>('POST', `${base}/${resource}`, session, body))
        previous.push({ name, groupId: created?.id ?? null, group: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} computer group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Computer-group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
