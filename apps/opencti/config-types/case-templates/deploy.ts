import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_CASE_TEMPLATE_MUTATION,
  LIST_CASE_TEMPLATES_QUERY,
  LIST_TASK_TEMPLATES_FOR_RESOLUTION_QUERY,
  PATCH_CASE_TEMPLATE_MUTATION,
  buildCaseTemplateInput,
  buildCaseTemplatePatch,
  caseTemplatesFromList,
  findCaseTemplate,
  resolveTaskTemplateIds,
  taskTemplateRefsFromList,
  toStringList,
  type OpenctiCaseTemplate,
} from './_shared'

/**
 * Deploy OpenCTI case templates over the GraphQL API:
 *   read (rollback + resolution): caseTemplates, taskTemplates → find the live
 *     case template by name, and resolve each item's `task_template_names`
 *     into live Case Task Template ids
 *   create: caseTemplateAdd(input) with { name, description?, tasks }
 *   update: caseTemplateFieldPatch(id, input) with [EditInput] (case template exists)
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per
 * case template, the prior node (null when it did not exist) AND its id — so
 * rollback can restore the prior body (including its prior task ids) or delete
 * the one we created. A task-template name with no live match is skipped (not a
 * deploy failure) and reported back in the result message/artifacts.
 */
async function listCaseTemplates(base: string, headers: Record<string, string>): Promise<OpenctiCaseTemplate[]> {
  try {
    return caseTemplatesFromList(await graphql<unknown>(base, headers, LIST_CASE_TEMPLATES_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for case-template deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; caseTemplateId: string | null; caseTemplate: OpenctiCaseTemplate | null }> = []
  const applied: string[] = []
  const allUnresolved: string[] = []

  try {
    const [live, liveTaskTemplates] = await Promise.all([
      listCaseTemplates(base, headers),
      graphql<unknown>(base, headers, LIST_TASK_TEMPLATES_FOR_RESOLUTION_QUERY).then(taskTemplateRefsFromList).catch(() => []),
    ])

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const { ids: taskIds, unresolved } = resolveTaskTemplateIds(toStringList(item.fields.task_template_names), liveTaskTemplates)
      if (unresolved.length > 0) allUnresolved.push(...unresolved.map((n) => `${name}: "${n}"`))

      const existing = findCaseTemplate(live, name)

      if (existing && existing.id != null) {
        const input = buildCaseTemplatePatch(item.fields, taskIds)
        await graphql(base, headers, PATCH_CASE_TEMPLATE_MUTATION, { id: existing.id, input })
        previous.push({ name, caseTemplateId: String(existing.id), caseTemplate: existing })
      } else {
        const created = await graphql<{ caseTemplateAdd?: OpenctiCaseTemplate }>(base, headers, ADD_CASE_TEMPLATE_MUTATION, {
          input: buildCaseTemplateInput(item.fields, taskIds),
        })
        const newId = created?.caseTemplateAdd?.id ?? null
        previous.push({ name, caseTemplateId: newId ? String(newId) : null, caseTemplate: null })
      }
      applied.push(name)
    }

    const unresolvedNote = allUnresolved.length > 0 ? ` (unresolved task template names, skipped: ${allUnresolved.join(', ')})` : ''
    return {
      success: true,
      message: `Applied ${applied.length} case template(s): ${applied.join(', ') || '(none)'}${unresolvedNote}`,
      artifacts: { applied, unresolvedTaskTemplateNames: allUnresolved },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Case-template deploy failed after ${applied.length} case template(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
