import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  parseJson,
  type InsightVMClient,
} from '../../lib/insightvm'
import { extractUserSpecs, userKey, type LiveUser, type UserSpec } from './validate'

/**
 * Rollback state for one user. ⚠ Deliberately carries NO password: the
 * write-only secret is never captured, so an updated user's prior identity
 * fields are recorded for visibility only — see rollback.ts for why an
 * in-place update cannot be safely reverted.
 */
export interface UserRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: number
  prior?: {
    login?: string
    name?: string
    email?: string
    enabled?: boolean
    role?: LiveUser['role']
    authentication?: LiveUser['authentication']
  }
}

/**
 * Deploy Rapid7 InsightVM console users via the Console API.
 *
 * Identity is the login: list /users, match on the login, then PUT an existing
 * user by id or POST a new one, followed by two reconciling calls — PUT
 * /users/{id}/sites and PUT /users/{id}/asset_groups — so declared site/asset
 * group access always matches the canvas (including removing access that was
 * granted before but is no longer declared). Site/asset group access is
 * ignored by the console when the user's role already grants all-sites /
 * all-asset-groups access.
 *
 * ⚠ PASSWORD: the console requires a password on every write (create AND
 * update — there is no partial-update path that omits it). It is therefore
 * ALWAYS sent, is masked by the API on read, and is NEVER read back, diffed or
 * stored in rollbackData / artifacts / logs. Redeploying an unchanged canvas
 * resets the user's password to the declared value every time.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractUserSpecs(ctx.canvas).filter((s) => s.login && s.name && s.roleId && s.password)
  const rollbackState: UserRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const accessResolver = new SiteAssetGroupResolver(client)

    const existing = await listUsers(client)
    const byKey = new Map(existing.filter((u) => u.login).map((u) => [userKey({ login: u.login as string }), u]))

    for (const spec of specs) {
      const label = spec.login
      const key = userKey(spec)
      const live = byKey.get(key)
      const siteIds = spec.allSites ? [] : await accessResolver.resolveSiteIds(spec)
      const assetGroupIds = spec.allAssetGroups ? [] : await accessResolver.resolveAssetGroupIds(spec)

      let userId: number
      if (live && live.id != null) {
        userId = live.id
        rollbackState.push({
          key,
          label,
          existed: true,
          id: userId,
          prior: { login: live.login, name: live.name, email: live.email, enabled: live.enabled, role: live.role, authentication: live.authentication },
        })
        const res = await client.request('PUT', `/users/${userId}`, { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to update user "${label}": ${insightVMErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/users', { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to create user "${label}": ${insightVMErrorMessage(res)}`)
        const created = parseJson<{ id?: number }>(res.body)
        if (created?.id == null) throw new Error(`User "${label}" was created but the API returned no id`)
        userId = created.id
        rollbackState.push({ key, label, existed: false, id: userId })
        createdIds.push(userId)
      }

      if (!spec.allSites) {
        const res = await client.request('PUT', `/users/${userId}/sites`, { body: siteIds })
        if (!res.ok) throw new Error(`Failed to set site access for user "${label}": ${insightVMErrorMessage(res)}`)
      }
      if (!spec.allAssetGroups) {
        const res = await client.request('PUT', `/users/${userId}/asset_groups`, { body: assetGroupIds })
        if (!res.ok) throw new Error(`Failed to set asset group access for user "${label}": ${insightVMErrorMessage(res)}`)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} user(s) to ${consoleUrl}: ${deployed.join(', ')}`,
      // artifacts carry logins only — never password or access-list ids.
      artifacts: { consoleUrl, deployedUsers: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `User deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedUsers: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all users; throws on a non-OK response. */
export async function listUsers(client: InsightVMClient): Promise<LiveUser[]> {
  const res = await client.getAll<LiveUser>('/users')
  if (!res.ok) {
    throw new Error(`Failed to list users: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** Resolves site / asset group names to ids, caching each collection the first time it is needed. */
export class SiteAssetGroupResolver {
  private sitesByName?: Map<string, number>
  private assetGroupsByName?: Map<string, number>

  constructor(private readonly client: InsightVMClient) {}

  async resolveSiteIds(spec: UserSpec): Promise<number[]> {
    if (spec.siteNames.length === 0) return []
    const byName = await this.getSitesByName()
    return spec.siteNames.map((name) => {
      const id = byName.get(name.toLowerCase())
      if (id == null) throw new Error(`Site "${name}" (referenced by user "${spec.login}") was not found on the console`)
      return id
    })
  }

  async resolveAssetGroupIds(spec: UserSpec): Promise<number[]> {
    if (spec.assetGroupNames.length === 0) return []
    const byName = await this.getAssetGroupsByName()
    return spec.assetGroupNames.map((name) => {
      const id = byName.get(name.toLowerCase())
      if (id == null) throw new Error(`Asset group "${name}" (referenced by user "${spec.login}") was not found on the console`)
      return id
    })
  }

  private async getSitesByName(): Promise<Map<string, number>> {
    if (this.sitesByName) return this.sitesByName
    const res = await this.client.getAll<{ id?: number; name?: string }>('/sites')
    if (!res.ok) throw new Error(`Failed to list sites: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
    const byName = new Map<string, number>()
    for (const site of res.items) {
      if (site.name && site.id != null) byName.set(site.name.toLowerCase(), site.id)
    }
    this.sitesByName = byName
    return byName
  }

  private async getAssetGroupsByName(): Promise<Map<string, number>> {
    if (this.assetGroupsByName) return this.assetGroupsByName
    const res = await this.client.getAll<{ id?: number; name?: string }>('/asset_groups')
    if (!res.ok) throw new Error(`Failed to list asset groups: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
    const byName = new Map<string, number>()
    for (const group of res.items) {
      if (group.name && group.id != null) byName.set(group.name.toLowerCase(), group.id)
    }
    this.assetGroupsByName = byName
    return byName
  }
}

/**
 * Build the /users request body (the UserEdit shape). ⚠ `password` is always
 * present — the API requires it on every create AND update — but it must never
 * leak out of this body into logs/artifacts/rollback.
 */
function buildBody(spec: UserSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    login: spec.login,
    name: spec.name,
    enabled: spec.enabled,
    password: spec.password,
    role: {
      id: spec.roleId,
      allSites: spec.allSites,
      allAssetGroups: spec.allAssetGroups,
      superuser: spec.superuser,
    },
  }
  if (spec.email) body.email = spec.email
  if (spec.passwordResetOnLogin) body.passwordResetOnLogin = true
  if (spec.authSourceType) {
    body.authentication = {
      type: spec.authSourceType,
      ...(spec.authSourceId !== undefined ? { id: spec.authSourceId } : {}),
    }
  }
  return body
}
