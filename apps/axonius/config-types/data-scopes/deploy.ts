import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, sendJson, verifyTls } from '../../lib/axoniusApi'
import { SAVED_QUERIES_LIST_RESOURCE, savedQueriesFromResponse } from '../saved-queries/_shared'
import {
  DATA_SCOPES_RESOURCE,
  CREATE_DATA_SCOPE_RESOURCE,
  updateDataScopeResource,
  dataScopesFromResponse,
  dataScopeId,
  findDataScope,
  resolveQueryNames,
  buildCreateBody,
  buildUpdateBody,
  parseText,
  parseNameList,
  type AxoniusDataScope,
} from './_shared'

/**
 * Deploy Axonius data scopes over the REST API (443):
 *   read:   GET  api/settings/data_scope          → one document, `scopes` array
 *   read:   GET  api/queries/saved                → resolve devices/users query names to uuids
 *   create: POST api/settings/data_scope           with { data: { type, attributes } }
 *   update: PUT  api/settings/data_scope/<uuid>    with { data: { type, attributes } }
 *
 * The scope name is the stable identity used to upsert. rollbackData records,
 * per scope, the prior attributes (null when it did not exist) AND the uuid —
 * so rollback restores the prior definition or deletes the one we created.
 * Requires the Data Scopes feature (Enterprise) enabled on the tenant; a
 * disabled feature surfaces as a clear API error here. Verify the JSON:API
 * shapes against a live Axonius tenant.
 */
interface CreateResponse {
  data?: { id?: string; attributes?: { uuid?: string } }
}

interface PriorEntry {
  name: string
  uuid: string | null
  attributes: Record<string, unknown> | null
}

async function listDataScopes(
  base: string,
  settings: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<AxoniusDataScope[]> {
  try {
    return dataScopesFromResponse(await getJson<unknown>(apiUrl(base, settings, DATA_SCOPES_RESOURCE), headers, { verifyTls: verifyTls(settings) }))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for data-scope deployment' }
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
    const live = await listDataScopes(base, settings, headers)
    const liveQueries = savedQueriesFromResponse(
      await getJson<unknown>(apiUrl(base, settings, SAVED_QUERIES_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }),
    )

    for (const item of items) {
      const name = parseText(item.fields.name)
      if (!name) continue
      const description = parseText(item.fields.description)
      const devicesQueries = resolveQueryNames(parseNameList(item.fields.devices_queries), liveQueries, 'devices')
      const usersQueries = resolveQueryNames(parseNameList(item.fields.users_queries), liveQueries, 'users')

      const existing = findDataScope(live, name)
      const existingId = dataScopeId(existing)

      if (existing && existingId) {
        await sendJson(
          'PUT',
          apiUrl(base, settings, updateDataScopeResource(existingId)),
          headers,
          buildUpdateBody({ uuid: existingId, name, description, devicesQueries, usersQueries }),
          opts,
        )
        previous.push({
          name,
          uuid: existingId,
          attributes: { name: existing.name, description: existing.description ?? '', devices_queries: existing.devices_queries ?? [], users_queries: existing.users_queries ?? [] },
        })
      } else {
        const created = await sendJson<CreateResponse>(
          'POST',
          apiUrl(base, settings, CREATE_DATA_SCOPE_RESOURCE),
          headers,
          buildCreateBody({ name, description, devicesQueries, usersQueries }),
          opts,
        )
        previous.push({ name, uuid: created?.data?.id ?? null, attributes: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} data scope${applied.length === 1 ? '' : 's'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Data-scope deploy failed after ${applied.length} scope${applied.length === 1 ? '' : 's'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
