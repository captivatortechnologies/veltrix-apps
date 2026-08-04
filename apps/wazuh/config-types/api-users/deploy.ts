import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, listAffectedItems, sendJson, wazuhRequest } from '../../lib/wazuhApi'
import { specFromItem, diffIdSets, resolveNamesToIds } from './_shared'

/**
 * Deploy Wazuh API users over the REST API (55000):
 *   read (upsert + rollback): GET    ${base}/security/users?limit=500      (id, username, allow_run_as, roles[])
 *   read (resolve role names): GET   ${base}/security/roles?limit=500
 *   create:                    POST  ${base}/security/users                { username, password }
 *   update password:           PUT   ${base}/security/users/{id}           { password }             (only when non-blank)
 *   toggle run_as:              PUT  ${base}/security/users/{id}/run_as?allow_run_as=true|false
 *   attach roles:               POST ${base}/security/users/{id}/roles?role_ids=1,2
 *   detach roles:                DELETE ${base}/security/users/{id}/roles?role_ids=1,2
 *
 * USERNAME is the stable identity used to upsert. `roles` are declared as the
 * user's COMPLETE set (by NAME, resolved to ids here) — each deploy reconciles
 * the live relationship to match exactly, same as the API Roles config type's
 * policy/rule reconciliation. An unresolvable role name fails that item's
 * deploy. `comment` is audit-only and is never sent to the manager.
 *
 * ⚠ WRITE-ONLY SECRET: `password` can never be read back from Wazuh, so it is
 * sent ONLY when its canvas field is non-blank, is never captured into
 * rollbackData/artifacts/logs, and is never drift-checked (see driftDetect.ts).
 * Creating a NEW user without a password fails that item's deploy (Wazuh
 * requires one); an EXISTING user with a blank password field keeps their
 * current password unchanged.
 *
 * rollbackData.previous records, per user, whether we created it (`created`)
 * and its PRIOR `allow_run_as` + role id set (false/empty for a freshly
 * created user).
 */
interface WazuhUser {
  id: number
  username: string
  allow_run_as: boolean
  roles: number[]
}
interface WazuhNamedResource {
  id: number
  name: string
}

export interface RollbackEntry {
  username: string
  id: number | null
  created: boolean
  priorAllowRunAs: boolean
  priorRoleIds: number[]
}

async function applyRelationshipDiff(
  baseUrl: string,
  auth: Record<string, string>,
  path: string,
  idParam: string,
  toAdd: number[],
  toRemove: number[],
): Promise<void> {
  if (toAdd.length) {
    const url = `${baseUrl}${path}?${idParam}=${toAdd.join(',')}`
    const res = await wazuhRequest(url, { method: 'POST', headers: auth })
    if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }
  if (toRemove.length) {
    const url = `${baseUrl}${path}?${idParam}=${toRemove.join(',')}`
    const res = await wazuhRequest(url, { method: 'DELETE', headers: auth })
    if (!res.ok) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for API-user deployment' }
  }

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    const existingUsers = await listAffectedItems<WazuhUser>(baseUrl, auth, '/security/users')
    const usersByUsername = new Map(existingUsers.map((u) => [u.username, u]))
    const rolesByName = new Map(
      (await listAffectedItems<WazuhNamedResource>(baseUrl, auth, '/security/roles')).map((r) => [r.name, r.id]),
    )

    for (const item of items) {
      const spec = specFromItem(item)
      if (!spec.username) continue

      const desiredRoleIds = resolveNamesToIds(spec.roleNames, rolesByName, 'Role')

      let user = usersByUsername.get(spec.username)
      let created = false
      let priorAllowRunAs = false
      let priorRoleIds: number[] = []

      if (!user) {
        if (!spec.password) {
          throw new Error(`User "${spec.username}" does not exist and no password was provided to create it`)
        }
        const createdRes = await sendJson<{ data?: { affected_items?: WazuhUser[] } }>('POST', `${baseUrl}/security/users`, auth, {
          username: spec.username,
          password: spec.password,
        })
        const newUser = createdRes.data?.affected_items?.[0]
        if (!newUser) throw new Error(`User "${spec.username}" was not returned after creation`)
        user = newUser
        created = true
      } else {
        priorAllowRunAs = user.allow_run_as
        priorRoleIds = user.roles
        if (spec.password) {
          await sendJson('PUT', `${baseUrl}/security/users/${user.id}`, auth, { password: spec.password })
        }
      }

      const runAsUrl = `${baseUrl}/security/users/${user.id}/run_as?allow_run_as=${spec.allowRunAs}`
      const runAsRes = await wazuhRequest(runAsUrl, { method: 'PUT', headers: auth })
      if (!runAsRes.ok) throw new Error(`PUT ${runAsUrl} → HTTP ${runAsRes.status}: ${runAsRes.body.slice(0, 300)}`)

      const roleDiff = diffIdSets(priorRoleIds, desiredRoleIds)
      await applyRelationshipDiff(baseUrl, auth, `/security/users/${user.id}/roles`, 'role_ids', roleDiff.toAdd, roleDiff.toRemove)

      previous.push({ username: spec.username, id: user.id, created, priorAllowRunAs, priorRoleIds })
      applied.push(spec.username)
    }

    return {
      success: true,
      message: `Applied ${applied.length} API user(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `API-user deploy failed after ${applied.length} user(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
