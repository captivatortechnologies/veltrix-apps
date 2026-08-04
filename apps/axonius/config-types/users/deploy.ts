import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, sendJson, verifyTls } from '../../lib/axoniusApi'
import { ROLES_LIST_RESOURCE, rolesFromResponse, findRoleByName, roleId } from '../roles/_shared'
import {
  USERS_LIST_RESOURCE,
  CREATE_USER_RESOURCE,
  updateUserResource,
  usersFromResponse,
  userId,
  findUser,
  buildCreateBody,
  buildUpdateBody,
  parseText,
  parseBool,
  type AxoniusUser,
} from './_shared'

/**
 * Deploy Axonius internal users over the REST API (443):
 *   read:   GET  api/settings/roles          → resolve role_name to role_id
 *   read:   GET  api/settings/users          → find the live user by user_name
 *   create: POST api/settings/users           with { data: { type, attributes } }
 *             (always auto_generated_password: true — never a supplied password)
 *   update: PUT  api/settings/users/<uuid>    with { data: { type, attributes } }
 *             (password never included, so a live user's password is never touched)
 *
 * The user_name is the stable identity used to upsert, scoped to
 * Axonius-internal accounts only (see findUser). rollbackData records, per
 * user, the prior attributes (null when it did not exist) AND the uuid — so
 * rollback restores the prior definition or deletes the one we created. Verify
 * the JSON:API shapes against a live Axonius tenant.
 */
interface PriorEntry {
  userName: string
  uuid: string | null
  attributes: Record<string, unknown> | null
}

async function listUsers(base: string, settings: Record<string, unknown>, headers: Record<string, string>): Promise<AxoniusUser[]> {
  try {
    return usersFromResponse(await getJson<unknown>(apiUrl(base, settings, USERS_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }))
  } catch {
    return []
  }
}

/** Resolve a role_name to its Axonius role id (built-in roles included). Throws with a clear message if not found. */
async function resolveRoleId(base: string, settings: Record<string, unknown>, headers: Record<string, string>, roleName: string): Promise<string> {
  const roles = rolesFromResponse(await getJson<unknown>(apiUrl(base, settings, ROLES_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }))
  const match = findRoleByName(roles, roleName)
  const id = roleId(match)
  if (!id) throw new Error(`Role "${roleName}" was not found. Deploy the roles config type first, or check the name.`)
  return id
}

function snapshotAttributes(user: AxoniusUser): Record<string, unknown> {
  return {
    user_name: user.user_name,
    role_id: user.role_id,
    email: user.email ?? '',
    first_name: user.first_name ?? '',
    last_name: user.last_name ?? '',
    title: user.title ?? '',
    department: user.department ?? '',
    ignore_role_assignment_rules: user.ignore_role_assignment_rules === true,
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for user deployment' }
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
    const liveUsers = await listUsers(base, settings, headers)

    for (const item of items) {
      const userName = parseText(item.fields.user_name)
      if (!userName) continue

      const resolvedRoleId = await resolveRoleId(base, settings, headers, parseText(item.fields.role_name))
      const email = parseText(item.fields.email)
      const firstName = parseText(item.fields.first_name)
      const lastName = parseText(item.fields.last_name)

      const existing = findUser(liveUsers, userName)
      const existingId = userId(existing)

      if (existing && existingId) {
        const body = buildUpdateBody({
          userName,
          roleId: resolvedRoleId,
          email,
          firstName,
          lastName,
          title: parseText(item.fields.title),
          department: parseText(item.fields.department),
          ignoreRoleAssignmentRules: parseBool(item.fields.ignore_role_assignment_rules),
        })
        await sendJson('PUT', apiUrl(base, settings, updateUserResource(existingId)), headers, body, opts)
        previous.push({ userName, uuid: existingId, attributes: snapshotAttributes(existing) })
      } else {
        const body = buildCreateBody({ userName, roleId: resolvedRoleId, email, firstName, lastName })
        const created = await sendJson<{ data?: { id?: string; attributes?: { uuid?: string } } }>(
          'POST',
          apiUrl(base, settings, CREATE_USER_RESOURCE),
          headers,
          body,
          opts,
        )
        previous.push({ userName, uuid: created?.data?.attributes?.uuid ?? created?.data?.id ?? null, attributes: null })
      }
      applied.push(userName)
    }

    return {
      success: true,
      message: `Applied ${applied.length} user${applied.length === 1 ? '' : 's'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `User deploy failed after ${applied.length} user${applied.length === 1 ? '' : 's'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
