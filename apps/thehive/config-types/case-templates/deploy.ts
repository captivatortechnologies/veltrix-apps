import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, listCaseTemplates, PRIMARY } from '../../lib/thehiveApi'
import { buildCaseTemplateBody, findCaseTemplate, templateId, templatesFromList, type CaseTemplate } from './_shared'

/**
 * Deploy TheHive case templates over the REST API:
 *   read (rollback): list templates                  → find the live one by name
 *   create:          POST   /api/v1/caseTemplate      with InputCaseTemplate
 *   update:          PATCH  /api/v1/caseTemplate/<id> with InputCaseTemplate
 *
 * The template name is the stable identity used to upsert. rollbackData records,
 * per template, the prior template body (null when it did not exist) AND the id —
 * so rollback can restore the prior body or delete the one we created.
 *
 * v5 paths are primary (see lib/thehiveApi.ts API_VERSION seam). Verify against a
 * live TheHive (see README, v4 vs v5).
 */
async function listTemplates(base: string, headers: Record<string, string>): Promise<CaseTemplate[]> {
  try {
    return templatesFromList(await listCaseTemplates<CaseTemplate>(base, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for case template deployment' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; templateId: string | null; template: CaseTemplate | null }> = []
  const applied: string[] = []

  try {
    const live = await listTemplates(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findCaseTemplate(live, name)
      const existingId = templateId(existing)
      const body = buildCaseTemplateBody(item.fields)

      if (existing && existingId) {
        await sendJson('PATCH', `${base}${PRIMARY.caseTemplateById(existingId)}`, headers, body)
        previous.push({ name, templateId: existingId, template: existing })
      } else {
        const created = await sendJson<CaseTemplate>('POST', `${base}${PRIMARY.caseTemplate}`, headers, body)
        previous.push({ name, templateId: templateId(created), template: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} case template(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Case template deploy failed after ${applied.length} template(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
