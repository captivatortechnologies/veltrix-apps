import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import { groupPermsFromTemplateGroups, reconcileGroupPerms, type GroupGrant } from './_shared'

/**
 * Undo a permission-templates deploy from rollbackData (written by deploy()):
 *   - a template we CREATED (existed=false) is deleted (POST /api/permissions/delete_template).
 *   - a template that already EXISTED has its description / project-key pattern restored
 *     (POST /api/permissions/update_template) and the declared groups' grants reconciled
 *     back to their recorded prior perms (add/remove_group_from_template).
 * Best-effort — a failure on one template does not abort the rest.
 */
interface TemplateEntry {
  name: string
  existed: boolean
  id: string
  priorDescription: string
  priorProjectKeyPattern: string
  priorGroupPerms: GroupGrant[]
}

const enc = encodeURIComponent

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { templates?: TemplateEntry[] }
  const templates = data.templates ?? []
  if (templates.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for permission template rollback' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  async function liveGroupPerms(name: string): Promise<Map<string, string[]>> {
    try {
      return groupPermsFromTemplateGroups(await getJson<unknown>(`${base}/api/permissions/template_groups?templateName=${enc(name)}&ps=100`, headers))
    } catch {
      return new Map()
    }
  }

  let removed = 0
  let restored = 0
  const failures: string[] = []

  for (const template of templates) {
    try {
      if (!template.existed) {
        await postForm(`${base}/api/permissions/delete_template`, headers, { templateName: template.name })
        removed++
        continue
      }
      // Restore description / project-key pattern (needs the template id).
      if (template.id) {
        await postForm(`${base}/api/permissions/update_template`, headers, {
          id: template.id,
          name: template.name,
          description: template.priorDescription || undefined,
          projectKeyPattern: template.priorProjectKeyPattern || undefined,
        })
      }
      // Reconcile declared groups back to their prior grants.
      if (template.priorGroupPerms?.length) {
        const live = await liveGroupPerms(template.name)
        const { toAdd, toRemove } = reconcileGroupPerms(template.priorGroupPerms, live)
        for (const { group, permission } of toAdd) {
          await postForm(`${base}/api/permissions/add_group_to_template`, headers, { templateName: template.name, groupName: group, permission })
        }
        for (const { group, permission } of toRemove) {
          await postForm(`${base}/api/permissions/remove_group_from_template`, headers, { templateName: template.name, groupName: group, permission })
        }
      }
      restored++
    } catch (error) {
      failures.push(`${template.name}: ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rollback partially failed: ${removed} removed, ${restored} restored. Errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back permission templates: ${removed} removed, ${restored} restored.` }
}
