import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_STATUS_TEMPLATE_MUTATION,
  LIST_STATUS_TEMPLATES_QUERY,
  PATCH_STATUS_TEMPLATE_MUTATION,
  buildStatusTemplateInput,
  buildStatusTemplatePatch,
  findStatusTemplate,
  statusTemplatesFromList,
  type OpenctiStatusTemplate,
} from './_shared'

/**
 * Deploy OpenCTI status templates over the GraphQL API:
 *   read (rollback): statusTemplates → find the live template by name
 *   create:          statusTemplateAdd(input) with { name, color } (both required)
 *   update:          statusTemplateFieldPatch(id, input) with [EditInput] (template exists)
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per
 * template, the prior template node (null when it did not exist) AND the
 * template id — so rollback can restore the prior body or delete the one we
 * created.
 *
 * NOTE: statusTemplateAdd returns the created template (with its new id).
 */
async function listStatusTemplates(base: string, headers: Record<string, string>): Promise<OpenctiStatusTemplate[]> {
  try {
    return statusTemplatesFromList(await graphql<unknown>(base, headers, LIST_STATUS_TEMPLATES_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for status template deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; statusTemplateId: string | null; statusTemplate: OpenctiStatusTemplate | null }> = []
  const applied: string[] = []

  try {
    const live = await listStatusTemplates(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findStatusTemplate(live, name)

      if (existing && existing.id != null) {
        const input = buildStatusTemplatePatch(item.fields)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_STATUS_TEMPLATE_MUTATION, { id: existing.id, input })
        }
        previous.push({ name, statusTemplateId: String(existing.id), statusTemplate: existing })
      } else {
        const created = await graphql<{ statusTemplateAdd?: OpenctiStatusTemplate }>(
          base,
          headers,
          ADD_STATUS_TEMPLATE_MUTATION,
          { input: buildStatusTemplateInput(item.fields) },
        )
        const newId = created?.statusTemplateAdd?.id ?? null
        previous.push({ name, statusTemplateId: newId ? String(newId) : null, statusTemplate: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} status template(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Status template deploy failed after ${applied.length} status template(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
