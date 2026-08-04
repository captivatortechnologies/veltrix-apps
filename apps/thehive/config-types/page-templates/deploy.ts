import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, listPageTemplates, isPageTemplateSupported, PAGE_TEMPLATE_PATHS_V5 } from '../../lib/thehiveApi'
import {
  buildPageTemplateCreateBody,
  buildPageTemplateUpdateBody,
  findPageTemplate,
  pageTemplateId,
  pageTemplatesFromList,
  type PageTemplate,
} from './_shared'

/**
 * Deploy TheHive page templates over the REST API:
 *   read (rollback): list page templates (query `listPageTemplate`) → find by title
 *   create:          POST  /api/v1/pageTemplate       with InputPageTemplate
 *   update:          PATCH /api/v1/pageTemplate/<id>   with InputUpdatePageTemplate (no title)
 *
 * V5-ONLY: Page Templates (Knowledge Base) have no TheHive 4 equivalent — see
 * lib/thehiveApi.ts (PAGE_TEMPLATE_PATHS_V5). This fails fast with a clear
 * message rather than guessing a v4 path if the seam is pointed at TheHive 4.
 *
 * The title is the stable identity used to upsert. rollbackData records, per
 * template, the prior body (null when it did not exist) AND the id — so
 * rollback can restore the prior content/category/order or delete the one we
 * created.
 */
async function listAll(base: string, headers: Record<string, string>): Promise<PageTemplate[]> {
  try {
    return pageTemplatesFromList(await listPageTemplates<PageTemplate>(base, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  if (!isPageTemplateSupported()) {
    return { success: false, message: 'Page Templates require TheHive 5 (Knowledge Base) — not available against a TheHive 4 target (API_VERSION is set to v4 in lib/thehiveApi.ts).' }
  }

  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for page template deployment' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ title: string; templateId: string | null; template: PageTemplate | null }> = []
  const applied: string[] = []

  try {
    const live = await listAll(base, headers)

    for (const item of items) {
      const title = String(item.fields.title ?? '').trim()
      if (!title) continue

      const existing = findPageTemplate(live, title)
      const existingId = pageTemplateId(existing)

      if (existing && existingId) {
        await sendJson('PATCH', `${base}${PAGE_TEMPLATE_PATHS_V5.pageTemplateById(existingId)}`, headers, buildPageTemplateUpdateBody(item.fields))
        previous.push({ title, templateId: existingId, template: existing })
      } else {
        const created = await sendJson<PageTemplate>('POST', `${base}${PAGE_TEMPLATE_PATHS_V5.pageTemplate}`, headers, buildPageTemplateCreateBody(item.fields))
        previous.push({ title, templateId: pageTemplateId(created), template: null })
      }
      applied.push(title)
    }

    return {
      success: true,
      message: `Applied ${applied.length} page template(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Page template deploy failed after ${applied.length} template(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
