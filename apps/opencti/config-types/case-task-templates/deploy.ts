import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_TASK_TEMPLATE_MUTATION,
  LIST_TASK_TEMPLATES_QUERY,
  PATCH_TASK_TEMPLATE_MUTATION,
  buildTaskTemplateInput,
  buildTaskTemplatePatch,
  findTaskTemplate,
  taskTemplatesFromList,
  type OpenctiTaskTemplate,
} from './_shared'

/**
 * Deploy OpenCTI case task templates over the GraphQL API:
 *   read (rollback): taskTemplates                → find the live template by name
 *   create:          taskTemplateAdd(input) with { name, description? }
 *   update:          taskTemplateFieldPatch(id, input) with [EditInput] (template exists)
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per
 * task template, the prior node (null when it did not exist) AND the id — so
 * rollback can restore the prior body or delete the one we created.
 *
 * NOTE: taskTemplateAdd returns the created template (with its new id).
 */
async function listTaskTemplates(base: string, headers: Record<string, string>): Promise<OpenctiTaskTemplate[]> {
  try {
    return taskTemplatesFromList(await graphql<unknown>(base, headers, LIST_TASK_TEMPLATES_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for case-task-template deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; templateId: string | null; template: OpenctiTaskTemplate | null }> = []
  const applied: string[] = []

  try {
    const live = await listTaskTemplates(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findTaskTemplate(live, name)

      if (existing && existing.id != null) {
        const input = buildTaskTemplatePatch(item.fields)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_TASK_TEMPLATE_MUTATION, { id: existing.id, input })
        }
        previous.push({ name, templateId: String(existing.id), template: existing })
      } else {
        const created = await graphql<{ taskTemplateAdd?: OpenctiTaskTemplate }>(base, headers, ADD_TASK_TEMPLATE_MUTATION, {
          input: buildTaskTemplateInput(item.fields),
        })
        const newId = created?.taskTemplateAdd?.id ?? null
        previous.push({ name, templateId: newId ? String(newId) : null, template: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} case task template(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Case-task-template deploy failed after ${applied.length} template(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
