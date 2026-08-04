import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson, sendJson } from '../../lib/vectraApi'
import { parseTags, tagsFromGet, taggingPath } from './_shared'

/**
 * Deploy Vectra entity tags over the Detect REST API (v2.5, 443):
 *   read (rollback): GET   /tagging/{host|account}/{id}
 *   write:            PATCH /tagging/{host|account}/{id}   body { tags: [...] }  (full replace)
 *
 * No create/delete — an entity's tag set is always PATCHed in place (the host or
 * account itself is discovered by Vectra, never created through this API).
 * rollbackData records, per entity, the prior tags (null when unreadable) so
 * rollback can restore them exactly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for entity tags deployment' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ entityType: string; entityId: string; tags: string[] | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const entityType = String(item.fields.entity_type ?? '').trim()
      const entityId = String(item.fields.entity_id ?? '').trim()
      if (!entityType || !entityId) continue

      const path = taggingPath(entityType, entityId)
      let priorTags: string[] | null = null
      try {
        priorTags = tagsFromGet(await getJson<unknown>(`${base}${path}`, headers))
      } catch {
        priorTags = null
      }
      previous.push({ entityType, entityId, tags: priorTags })

      const desired = parseTags(item.fields.tags)
      await sendJson('PATCH', `${base}${path}`, headers, { tags: desired })
      applied.push(`${entityType}:${entityId}`)
    }

    return {
      success: true,
      message: `Applied tags for ${applied.length} entit${applied.length === 1 ? 'y' : 'ies'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Entity tags deploy failed after ${applied.length} entit${applied.length === 1 ? 'y' : 'ies'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
