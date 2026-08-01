import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, sendJson, verifyTls } from '../../lib/axoniusApi'
import {
  SAVED_QUERIES_LIST_RESOURCE,
  createSavedQueryResource,
  updateSavedQueryResource,
  buildSavedQueryBody,
  savedQueriesFromResponse,
  savedQueryId,
  findSavedQuery,
  normalizeEntity,
  parseFilter,
  parseFields,
  type AxoniusSavedQuery,
} from './_shared'

/**
 * Deploy Axonius saved queries over the REST API (443):
 *   read (rollback): GET  api/queries/saved      → find the live query by name+module
 *   create:          POST api/queries/<module>    with { data: { type, attributes } }
 *   update:          PUT  api/queries/<uuid>       with { data: { type, attributes } }
 *
 * The (module, name) pair is the stable identity used to upsert. rollbackData
 * records, per query, the prior attributes (null when it did not exist) AND the
 * uuid — so rollback restores the prior definition or deletes the one we created.
 *
 * Verify the JSON:API shapes against a live Axonius tenant.
 */
interface SavedQueryMutationResponse {
  data?: { id?: string; attributes?: Record<string, unknown> }
}

interface PriorEntry {
  name: string
  entity: string
  uuid: string | null
  attributes: Record<string, unknown> | null
}

/** Read every live saved query (best-effort) for identity matching + rollback snapshots. */
async function listSavedQueries(
  base: string,
  settings: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<AxoniusSavedQuery[]> {
  try {
    return savedQueriesFromResponse(
      await getJson<unknown>(apiUrl(base, settings, SAVED_QUERIES_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }),
    )
  } catch {
    return []
  }
}

/** Snapshot the mutable attributes of a live query so rollback can restore them. */
function snapshotAttributes(sq: AxoniusSavedQuery): Record<string, unknown> {
  return {
    name: sq.name,
    view: sq.view ?? {},
    description: sq.description ?? '',
    tags: sq.tags ?? [],
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for saved-query deployment' }
  }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) {
    return { success: false, message: 'Axonius needs an API key (username) and API secret (token) — attach both to this connection.' }
  }
  const opts = { verifyTls: verifyTls(settings) }

  const previous: PriorEntry[] = []
  const applied: string[] = []

  try {
    const live = await listSavedQueries(base, settings, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const entity = normalizeEntity(item.fields.entity)
      const body = buildSavedQueryBody({
        name,
        filter: parseFilter(item.fields.query),
        columns: parseFields(item.fields.fields),
        description: String(item.fields.description ?? '').trim(),
      })

      const existing = findSavedQuery(live, name, entity)
      const existingId = savedQueryId(existing)

      if (existing && existingId) {
        await sendJson('PUT', apiUrl(base, settings, updateSavedQueryResource(existingId)), headers, body, opts)
        previous.push({ name, entity, uuid: existingId, attributes: snapshotAttributes(existing) })
      } else {
        const created = await sendJson<SavedQueryMutationResponse>(
          'POST',
          apiUrl(base, settings, createSavedQueryResource(entity)),
          headers,
          body,
          opts,
        )
        previous.push({ name, entity, uuid: created?.data?.id ?? null, attributes: null })
      }
      applied.push(`${entity}/${name}`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} saved quer${applied.length === 1 ? 'y' : 'ies'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Saved-query deploy failed after ${applied.length} quer${applied.length === 1 ? 'y' : 'ies'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
