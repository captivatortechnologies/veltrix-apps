import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import {
  templatesFromSearch,
  findTemplate,
  parseGroupPermissions,
  groupPermsFromTemplateGroups,
  reconcileGroupPerms,
  type SonarPermissionTemplate,
  type GroupGrant,
} from './_shared'

/**
 * Deploy SonarQube permission templates over the Web API (/api/permissions/*_template):
 *   search (context):  GET  /api/permissions/search_templates?q=..   → find the template + id
 *   create:            POST /api/permissions/create_template         { name, description?, projectKeyPattern? }
 *   update:            POST /api/permissions/update_template         { id, name, description?, projectKeyPattern? }
 *   group grants:      GET  /api/permissions/template_groups         → live group perms (reconcile)
 *                      POST /api/permissions/add_group_to_template   { templateName, groupName, permission }
 *                      POST /api/permissions/remove_group_from_template { templateName, groupName, permission }
 *
 * The template NAME is the stable identity used to upsert; update_template needs the id,
 * resolved from search_templates. Only the groups the canvas declares are reconciled —
 * undeclared groups are left untouched. rollbackData records, per template, whether it
 * existed, its id, prior description / project-key pattern and the prior perms of the
 * declared groups — so rollback can restore the prior state or delete a template we created.
 *
 * NOTE: an empty description / project-key pattern is not sent (the form-encoder drops
 * blanks), so those fields are set/updated but not cleared by an empty value.
 */
interface CreateResponse {
  permissionTemplate?: SonarPermissionTemplate
}

const enc = encodeURIComponent

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for permission template deployment' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  async function searchByName(name: string): Promise<SonarPermissionTemplate | null> {
    try {
      return findTemplate(templatesFromSearch(await getJson<unknown>(`${base}/api/permissions/search_templates?q=${enc(name)}`, headers)), name)
    } catch {
      return null
    }
  }
  async function liveGroupPerms(name: string): Promise<Map<string, string[]>> {
    try {
      return groupPermsFromTemplateGroups(await getJson<unknown>(`${base}/api/permissions/template_groups?templateName=${enc(name)}&ps=100`, headers))
    } catch {
      return new Map()
    }
  }

  interface TemplateEntry {
    name: string
    existed: boolean
    id: string
    priorDescription: string
    priorProjectKeyPattern: string
    priorGroupPerms: GroupGrant[]
  }
  const templates: TemplateEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const description = String(item.fields.description ?? '').trim()
      const projectKeyPattern = String(item.fields.projectKeyPattern ?? '').trim()
      const { grants } = parseGroupPermissions(item.fields.groupPermissions)

      const existing = await searchByName(name)
      const existed = existing != null
      const priorDescription = existing?.description ? String(existing.description) : ''
      const priorProjectKeyPattern = existing?.projectKeyPattern ? String(existing.projectKeyPattern) : ''

      let id = existing?.id ? String(existing.id) : ''
      if (!existed) {
        const created = await postForm<CreateResponse>(`${base}/api/permissions/create_template`, headers, {
          name,
          description: description || undefined,
          projectKeyPattern: projectKeyPattern || undefined,
        })
        id = created?.permissionTemplate?.id ? String(created.permissionTemplate.id) : ''
      } else {
        await postForm(`${base}/api/permissions/update_template`, headers, {
          id,
          name,
          description: description || undefined,
          projectKeyPattern: projectKeyPattern || undefined,
        })
      }

      // Reconcile the declared group grants; capture the prior perms of declared groups.
      const live = await liveGroupPerms(name)
      const priorGroupPerms: GroupGrant[] = grants.map((g) => ({ group: g.group, permissions: live.get(g.group) ?? [] }))
      const { toAdd, toRemove } = reconcileGroupPerms(grants, live)
      for (const { group, permission } of toAdd) {
        await postForm(`${base}/api/permissions/add_group_to_template`, headers, { templateName: name, groupName: group, permission })
      }
      for (const { group, permission } of toRemove) {
        await postForm(`${base}/api/permissions/remove_group_from_template`, headers, { templateName: name, groupName: group, permission })
      }

      templates.push({ name, existed, id, priorDescription, priorProjectKeyPattern, priorGroupPerms })
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} permission template(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { templates },
    }
  } catch (error) {
    return {
      success: false,
      message: `Permission template deploy failed after ${applied.length} template(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { templates },
    }
  }
}
