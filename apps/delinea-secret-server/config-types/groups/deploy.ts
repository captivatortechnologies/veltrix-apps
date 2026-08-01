import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage, parseJson } from '../../lib/secretServerApi'
import {
  extractGroupSpecs,
  searchGroups,
  findGroupByName,
  buildGroupCreateBody,
  buildGroupUpdateBody,
  groupIdOf,
  isSynchronizedGroup,
  type LiveGroup,
} from './_shared'

/**
 * One group's prior state, captured for rollback. `existed` distinguishes an
 * UPDATE (restore `prior`) from a CREATE (leave the new group in place).
 */
export interface GroupRollbackEntry {
  groupName: string
  groupId: number | null
  existed: boolean
  prior: LiveGroup | null
}

/**
 * Deploy Secret Server (local) groups over the REST API (/api/v1/groups):
 *   read:   GET  /groups?filter.searchText=<name>  → match by name
 *   create: POST /groups                           with { name, enabled }
 *   update: PUT  /groups/{id}                       with the managed fields
 *
 * Identity is groupName. rollbackData records, per group, the prior body (null
 * when it did not exist) AND its id — so rollback can restore the prior body, or
 * leave a newly created group in place (group deletion is not managed by this app).
 *
 * A group synchronized from Directory Services is skipped on update (it is owned
 * by the directory). NOTE: create is verified against the Delinea/Thycotic
 * module; the PUT /groups/{id} update path is UNVERIFIED there — verify against a
 * live Secret Server instance.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiBase } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const specs = extractGroupSpecs(items).filter((s) => s.groupName)

  const previous: GroupRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      const matches = await searchGroups(client, spec.groupName)
      const existing = findGroupByName(matches, spec.groupName)

      if (existing) {
        if (isSynchronizedGroup(existing)) {
          throw new Error(`Group "${spec.groupName}" is synchronized from Directory Services and cannot be managed here`)
        }
        const groupId = groupIdOf(existing)
        if (groupId === null) throw new Error(`Group "${spec.groupName}" exists but has no usable id`)
        const res = await client.request('PUT', `/groups/${groupId}`, { body: buildGroupUpdateBody(spec, existing) })
        if (!res.ok) throw new Error(`Failed to update group "${spec.groupName}": ${secretServerErrorMessage(res)}`)
        previous.push({ groupName: spec.groupName, groupId, existed: true, prior: existing })
      } else {
        const res = await client.request('POST', '/groups', { body: buildGroupCreateBody(spec) })
        if (!res.ok) throw new Error(`Failed to create group "${spec.groupName}": ${secretServerErrorMessage(res)}`)
        const created = parseJson<LiveGroup>(res.body)
        previous.push({
          groupName: spec.groupName,
          groupId: created ? groupIdOf(created) : null,
          existed: false,
          prior: null,
        })
      }
      applied.push(spec.groupName)
    }

    return {
      success: true,
      message: `Applied ${applied.length} group(s) to ${apiBase}: ${applied.join(', ') || '(none)'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Group deploy failed after ${applied.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  }
}
