import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, sendJson, withSession } from '../../lib/beyondtrustApi'
import { buildCreateBody, findUserGroup, groupIdOf, groupsFromList, str, type UserGroup } from './_shared'

/**
 * Deploy BeyondInsight user groups over the BeyondInsight REST API inside a
 * PS-Auth session:
 *   read (identity): GET  /UserGroups      → match by (case-insensitive) name
 *   create:          POST /UserGroups      with the BeyondInsight group body
 *
 * Password Safe has NO update (PUT) endpoint for a user group, so this is a
 * create-if-absent upsert: a group already present on its name is left untouched
 * and reported — changing it means delete + recreate (which drops the group's
 * permissions + members) and is never done implicitly.
 *
 * rollbackData records, per group, whether WE created it and its assigned id, so
 * rollback can delete exactly the groups this deploy added.
 *
 * NOTE: verify /UserGroups create + list against a live BeyondTrust instance.
 */
interface RollbackEntry {
  groupName: string
  groupId: number | string | null
  action: 'created' | 'existing'
}

async function listUserGroups(base: string, cookie: string): Promise<UserGroup[]> {
  try {
    return groupsFromList(await getJson<unknown>(base, '/UserGroups', cookie))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for user group deployment' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  const previous: RollbackEntry[] = []
  const created: string[] = []
  const existing: string[] = []

  try {
    await withSession(base, credential, async (cookie) => {
      const live = await listUserGroups(base, cookie)

      for (const item of items) {
        const groupName = str(item.fields.groupName)
        if (!groupName) continue

        const match = findUserGroup(live, groupName)
        if (match) {
          existing.push(groupName)
          previous.push({ groupName, groupId: groupIdOf(match), action: 'existing' })
          continue
        }

        const body = buildCreateBody(item.fields)
        const res = await sendJson<UserGroup>('POST', base, '/UserGroups', cookie, body)
        created.push(groupName)
        previous.push({ groupName, groupId: groupIdOf(res ?? {}), action: 'created' })
      }
    })

    const parts: string[] = []
    if (created.length) parts.push(`${created.length} created`)
    if (existing.length) parts.push(`${existing.length} already present (no update endpoint — delete & recreate to change)`)
    return {
      success: true,
      message: `User groups: ${parts.join(', ') || '(none)'}`,
      artifacts: { created, existing },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `User group deploy failed after ${created.length} created: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { created, existing },
      rollbackData: { previous },
    }
  }
}
