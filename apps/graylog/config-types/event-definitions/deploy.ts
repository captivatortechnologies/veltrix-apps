import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildEventDefinitionEntity, eventDefinitionsFromList, findEventDefinition, type GraylogEventDefinition } from './_shared'

/**
 * Deploy Graylog event definitions over the REST API:
 *   read (rollback): GET  /api/events/definitions                    → find the live definition by title
 *   create:          POST /api/events/definitions?schedule={bool}     → { entity: {...} } → EventDefinitionDto { id, ... }
 *   update:          PUT  /api/events/definitions/{id}?schedule={bool} → EventDefinitionDto (id in body must match URL)
 *
 * `schedule` (from the canvas "enabled" checkbox) enables/disables the
 * definition on write. The definition TITLE is the stable identity used to
 * upsert. rollbackData records, per definition, the prior definition (null
 * when it did not exist) AND its id — so rollback can restore the prior
 * config or delete the one we created.
 */
async function listEventDefinitions(base: string, headers: Record<string, string>): Promise<GraylogEventDefinition[]> {
  try {
    return eventDefinitionsFromList(await getJson<unknown>(`${base}/api/events/definitions`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for event-definition deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ title: string; definitionId: string | null; definition: GraylogEventDefinition | null }> = []
  const applied: string[] = []

  try {
    const live = await listEventDefinitions(base, headers)

    for (const item of items) {
      const title = asString(item.fields.title)
      if (!title) continue

      const { entity, schedule, error } = buildEventDefinitionEntity(item.fields)
      if (error || !entity) throw new Error(`Event definition "${title}": ${error ?? 'could not build request body'}`)

      const existing = findEventDefinition(live, title)
      if (existing && existing.id) {
        await sendJson(
          'PUT',
          `${base}/api/events/definitions/${encodeURIComponent(existing.id)}?schedule=${schedule}`,
          headers,
          { id: existing.id, ...entity },
        )
        previous.push({ title, definitionId: existing.id, definition: existing })
      } else {
        const created = await sendJson<GraylogEventDefinition>(
          'POST',
          `${base}/api/events/definitions?schedule=${schedule}`,
          headers,
          { entity, share_request: null },
        )
        previous.push({ title, definitionId: created?.id ?? null, definition: null })
      }
      applied.push(title)
    }

    return {
      success: true,
      message: `Applied ${applied.length} event definition(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Event-definition deploy failed after ${applied.length} definition(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
