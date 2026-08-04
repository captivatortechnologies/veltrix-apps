import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, sendJson, verifyTls } from '../../lib/axoniusApi'
import { DATA_SCOPES_RESOURCE, dataScopesFromResponse, findDataScope, dataScopeId } from '../data-scopes/_shared'
import {
  ROLES_LIST_RESOURCE,
  CREATE_ROLE_RESOURCE,
  updateRoleResource,
  rolesFromResponse,
  roleId,
  findRole,
  buildDataScopeRestriction,
  buildRoleBody,
  parseText,
  parseBool,
  parsePermissions,
  type AxoniusRole,
} from './_shared'

/**
 * Deploy Axonius roles over the REST API (443):
 *   read:   GET  api/settings/roles          → find the live role by name
 *   read:   GET  api/settings/data_scope      → resolve a data-scope name to its uuid
 *   create: POST api/settings/roles           with { data: { type, attributes } }
 *   update: PUT  api/settings/roles/<uuid>    with { data: { type, attributes } }
 *
 * The role name is the stable identity used to upsert (predefined built-in
 * roles are never matched — see findRole). rollbackData records, per role, the
 * prior attributes (null when it did not exist) AND the uuid — so rollback
 * restores the prior definition or deletes the one we created. Verify the
 * JSON:API shapes against a live Axonius tenant.
 */
interface PriorEntry {
  name: string
  uuid: string | null
  attributes: Record<string, unknown> | null
}

async function listRoles(base: string, settings: Record<string, unknown>, headers: Record<string, string>): Promise<AxoniusRole[]> {
  try {
    return rolesFromResponse(await getJson<unknown>(apiUrl(base, settings, ROLES_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }))
  } catch {
    return []
  }
}

/** Resolve a data-scope name to its uuid, or null when the restriction is disabled. */
async function resolveDataScopeUuid(
  base: string,
  settings: Record<string, unknown>,
  headers: Record<string, string>,
  enabled: boolean,
  name: string,
): Promise<string | null> {
  if (!enabled) return null
  const list = dataScopesFromResponse(await getJson<unknown>(apiUrl(base, settings, DATA_SCOPES_RESOURCE), headers, { verifyTls: verifyTls(settings) }))
  const match = findDataScope(list, name)
  const uuid = dataScopeId(match)
  if (!uuid) throw new Error(`Data scope "${name}" was not found. Deploy the data-scopes config type first, or check the name.`)
  return uuid
}

function snapshotAttributes(role: AxoniusRole): Record<string, unknown> {
  return { name: role.name, permissions: role.permissions ?? {}, data_scope_restriction: role.data_scope_restriction ?? { enabled: false, data_scope: null } }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for role deployment' }
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
    const live = await listRoles(base, settings, headers)

    for (const item of items) {
      const name = parseText(item.fields.name)
      if (!name) continue
      const permissions = parsePermissions(item.fields.permissions)
      if (!permissions.ok) throw new Error(`Role "${name}" has invalid permissions: ${permissions.error}`)

      const dataScopeEnabled = parseBool(item.fields.data_scope_enabled)
      const dataScopeUuid = await resolveDataScopeUuid(base, settings, headers, dataScopeEnabled, parseText(item.fields.data_scope_name))
      const dataScopeRestriction = buildDataScopeRestriction(dataScopeEnabled, dataScopeUuid)

      const body = buildRoleBody({ name, permissions: permissions.value, dataScopeRestriction })

      const existing = findRole(live, name)
      const existingId = roleId(existing)

      if (existing && existingId) {
        await sendJson('PUT', apiUrl(base, settings, updateRoleResource(existingId)), headers, body, opts)
        previous.push({ name, uuid: existingId, attributes: snapshotAttributes(existing) })
      } else {
        const created = await sendJson<{ data?: { id?: string; attributes?: { uuid?: string } } }>(
          'POST',
          apiUrl(base, settings, CREATE_ROLE_RESOURCE),
          headers,
          body,
          opts,
        )
        previous.push({ name, uuid: created?.data?.attributes?.uuid ?? created?.data?.id ?? null, attributes: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} role${applied.length === 1 ? '' : 's'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role deploy failed after ${applied.length} role${applied.length === 1 ? '' : 's'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
