import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, sendJson } from '../../lib/sumoLogicApi'
import { buildFieldCreateBody, fieldsFromList, findField, isFieldEnabled, normalizeEnabled, type CustomField } from './_shared'

/**
 * Deploy Sumo Logic custom fields over the Management API (HTTPS):
 *   read (upsert/rollback): GET    /fields                → { data: [...] }
 *   create:                 POST   /fields                with { fieldName } (created Enabled)
 *   enable:                 PUT    /fields/<id>/enable
 *   disable:                DELETE /fields/<id>/disable
 *
 * The field NAME is the stable identity used to upsert. A field's on/off status
 * is a state transition, not a body value, so deploy creates the field when
 * absent then converges its state to the desired `enabled`. rollbackData records,
 * per field, the prior field (null when it did not exist) AND its id — so
 * rollback can restore the prior state or delete the one we created.
 *
 * API: https://www.sumologic.com/help/docs/api/field-management/
 * Endpoints verified against the SumoLogic terraform provider
 * (sumologic/sumologic_field.go).
 */
async function setEnabled(base: string, headers: Record<string, string>, fieldId: string, enabled: boolean): Promise<void> {
  const path = `${base}/fields/${encodeURIComponent(fieldId)}/${enabled ? 'enable' : 'disable'}`
  await sendJson(enabled ? 'PUT' : 'DELETE', path, headers)
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for custom field deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ fieldName: string; fieldId: string | null; field: CustomField | null }> = []
  const applied: string[] = []

  let live: CustomField[] = []
  try {
    live = fieldsFromList(await getJson<unknown>(`${base}/fields`, headers))
  } catch {
    live = []
  }

  try {
    for (const item of items) {
      const fieldName = String(item.fields.fieldName ?? '').trim()
      if (!fieldName) continue

      const desiredEnabled = normalizeEnabled(item.fields.enabled)
      const existing = findField(live, fieldName)

      if (existing && existing.fieldId != null) {
        const id = String(existing.fieldId)
        if (desiredEnabled !== isFieldEnabled(existing)) {
          await setEnabled(base, headers, id, desiredEnabled)
        }
        previous.push({ fieldName, fieldId: id, field: existing })
      } else {
        const created = await sendJson<CustomField>('POST', `${base}/fields`, headers, buildFieldCreateBody(item.fields))
        const id = created?.fieldId != null ? String(created.fieldId) : null
        // A new field is created Enabled — disable it when the operator asked for off.
        if (id && !desiredEnabled) await setEnabled(base, headers, id, false)
        previous.push({ fieldName, fieldId: id, field: null })
      }
      applied.push(fieldName)
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
