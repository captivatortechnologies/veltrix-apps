import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, sendJson, verifyTls } from '../../lib/axoniusApi'
import {
  labelsResource,
  buildTagBody,
  tagNamesFromResponse,
  tagExists,
  normalizeEntity,
  parseText,
  type TagEntity,
} from './_shared'

/**
 * Deploy Axonius tags over the REST API (443): add each declared label to every
 * asset matching its AQL filter.
 *   read (rollback): GET api/<module>/labels  → whether the label already existed
 *   apply:           PUT api/<module>/labels   with { entities, labels, filter }
 *
 * The (module, tag) pair is the identity — adding a label is idempotent, so a
 * re-deploy simply re-asserts membership. rollbackData records, per tag, the
 * module + label + filter used (so rollback removes the label from exactly the
 * assets we tagged) and whether the label pre-existed in the module.
 *
 * Verify the JSON:API shapes against a live Axonius tenant.
 */
interface PriorEntry {
  entity: TagEntity
  label: string
  filter: string
  existedBefore: boolean
}

/** Read a module's existing label names (best-effort) so rollback knows if a tag is new. */
async function listLabels(
  base: string,
  settings: Record<string, unknown>,
  headers: Record<string, string>,
  entity: TagEntity,
): Promise<string[]> {
  try {
    return tagNamesFromResponse(
      await getJson<unknown>(apiUrl(base, settings, labelsResource(entity)), headers, { verifyTls: verifyTls(settings) }),
    )
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for tag deployment' }
  }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) {
    return { success: false, message: 'Axonius needs an API key (username) and API secret (token) — attach both to this connection.' }
  }
  const opts = { verifyTls: verifyTls(settings) }

  const previous: PriorEntry[] = []
  const applied: string[] = []
  const labelCache = new Map<TagEntity, string[]>()

  try {
    for (const item of items) {
      const label = parseText(item.fields.name)
      if (!label) continue
      const entity = normalizeEntity(item.fields.entity)
      const filter = parseText(item.fields.filter)
      const expiration = parseText(item.fields.expiration)

      if (!labelCache.has(entity)) labelCache.set(entity, await listLabels(base, settings, headers, entity))
      const existedBefore = tagExists(labelCache.get(entity) ?? [], label)

      await sendJson('PUT', apiUrl(base, settings, labelsResource(entity)), headers, buildTagBody({ label, filter, expiration }), opts)

      previous.push({ entity, label, filter, existedBefore })
      applied.push(`${entity}/${label}`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} tag${applied.length === 1 ? '' : 's'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Tag deploy failed after ${applied.length} tag${applied.length === 1 ? '' : 's'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
