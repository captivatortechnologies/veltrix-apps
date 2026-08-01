import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, listCustomFields, PRIMARY } from '../../lib/thehiveApi'
import {
  buildCustomFieldBody,
  buildCustomFieldUpdate,
  customFieldId,
  customFieldsFromList,
  findCustomField,
  type CustomField,
} from './_shared'

/**
 * Deploy TheHive custom fields over the REST API:
 *   read (rollback): GET /api/v1/customField          → find the live one by name
 *   create:          POST   /api/v1/customField         with InputCustomField
 *   update:          PATCH  /api/v1/customField/<id>     with InputUpdateCustomField (no name)
 *
 * The field name is the stable identity used to upsert. rollbackData records,
 * per field, the prior body (null when it did not exist) AND the id — so rollback
 * can restore the prior body or delete the one we created.
 *
 * v5 paths are primary (see lib/thehiveApi.ts API_VERSION seam). Verify against a
 * live TheHive (see README, v4 vs v5).
 */
async function listFields(base: string, headers: Record<string, string>): Promise<CustomField[]> {
  try {
    return customFieldsFromList(await listCustomFields<CustomField>(base, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for custom field deployment' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; fieldId: string | null; field: CustomField | null }> = []
  const applied: string[] = []

  try {
    const live = await listFields(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findCustomField(live, name)
      const existingId = customFieldId(existing)

      if (existing && existingId) {
        await sendJson('PATCH', `${base}${PRIMARY.customFieldById(existingId)}`, headers, buildCustomFieldUpdate(item.fields))
        previous.push({ name, fieldId: existingId, field: existing })
      } else {
        const created = await sendJson<CustomField>('POST', `${base}${PRIMARY.customField}`, headers, buildCustomFieldBody(item.fields))
        previous.push({ name, fieldId: customFieldId(created), field: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom field(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom field deploy failed after ${applied.length} field(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
