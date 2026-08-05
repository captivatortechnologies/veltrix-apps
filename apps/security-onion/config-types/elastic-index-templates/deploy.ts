import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildEsUrl, buildAuthHeader, getJson, sendJson } from '../../lib/soConsole'
import { buildIndexTemplateBody, type IndexTemplateGetResponse } from './_shared'

/**
 * Deploy Elasticsearch index templates via the REST API (9200):
 *   read (rollback): GET  ${esUrl}/_index_template/<name>?flat_settings=true  (best-effort — 404 = new)
 *   apply:           PUT  ${esUrl}/_index_template/<name>                    with a body from the fields
 *
 * `flat_settings=true` is requested on every GET so a setting sent as the flat
 * dotted key `index.lifecycle.name` reads back the same way instead of the
 * nested `{"index":{"lifecycle":{"name": ...}}}` form Elasticsearch normally
 * returns — see
 * https://www.elastic.co/guide/en/elasticsearch/reference/current/indices-get-template.html
 *
 * This manages CUSTOM index templates (third-party/custom log sources) that
 * pair with this app's `elastic-ilm` policies; it does not touch Security
 * Onion's own built-in templates (see README Coverage for the boundary).
 *
 * rollbackData records the prior template body per name (null when it did not
 * exist) so rollback can PUT it back or DELETE the one we created.
 */

/** Read the live template body (best-effort) for the rollback snapshot; null on any miss. */
async function readTemplate(esUrl: string, auth: Record<string, string>, templateName: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await getJson<IndexTemplateGetResponse>(`${esUrl}/_index_template/${encodeURIComponent(templateName)}?flat_settings=true`, auth)
    return res.index_templates?.find((t) => t.name === templateName)?.index_template ?? null
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for index template deployment' }
  }

  const esUrl = buildEsUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  const previous: Array<{ templateName: string; template: Record<string, unknown> | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const templateName = String(item.fields.templateName ?? '').trim()
      if (!templateName) continue

      previous.push({ templateName, template: await readTemplate(esUrl, auth, templateName) })

      const body = buildIndexTemplateBody(item.fields)
      await sendJson('PUT', `${esUrl}/_index_template/${encodeURIComponent(templateName)}`, auth, body)
      applied.push(templateName)
    }

    return {
      success: true,
      message: `Applied ${applied.length} index template(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Index template deploy failed after ${applied.length} template(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
