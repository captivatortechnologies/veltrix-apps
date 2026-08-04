import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { cyberArkErrorMessage, parseCollectionArray, parseJson, parseJsonObject, buildCyberArkClient, type CyberArkClient } from '../../lib/cyberark'
import { usernameKey, extractVaultUserSpecs, type LiveVaultUser, type VaultUserSpec } from './validate'

/**
 * Rollback state for one user. `prior` carries ONLY non-secret fields — the
 * write-only initial password is never read back or stored, so a restored
 * user keeps whatever password it already has.
 */
export interface VaultUserRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveVaultUser
}

/**
 * Deploy CyberArk Vault users via the PVWA Gen2 REST API.
 *
 * Identity is the username: list /Users, match by username, PUT an existing
 * user (its non-secret fields) or POST a new one.
 *
 * ⚠ SECRET: the initial password is WRITE-ONLY and sent ONLY on create. It is
 * never read back, diffed, or stored. To rotate an existing user's password,
 * use CyberArk's own Reset Password / change-password workflow — this app
 * does not manage secret rotation.
 *
 * NOTE: /Users is listed WITHOUT an explicit pageOffset/pageSize (PVWA
 * returns the full matching set on a plain GET) — the same "not
 * offset/limit paginated" assumption this app already makes for Platforms and
 * Automatic Onboarding Rules. A very large Vault user population should be
 * scoped with a naming convention this app's users are drawn from.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractVaultUserSpecs(ctx.canvas).filter((s) => s.username)
  const rollbackState: VaultUserRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const byKey = await mapUsers(client)

    for (const spec of specs) {
      const label = spec.username
      const key = usernameKey(spec)
      const live = byKey.get(key)

      if (live?.id !== undefined) {
        rollbackState.push({ key, label, existed: true, id: String(live.id), prior: live })
        const res = await client.request('PUT', `/Users/${encodeURIComponent(String(live.id))}`, { body: buildUpdateBody(spec, live) })
        if (!res.ok) throw new Error(`Failed to update user "${label}": ${cyberArkErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/Users', { body: buildCreateBody(spec) })
        if (!res.ok) throw new Error(`Failed to create user "${label}": ${cyberArkErrorMessage(res)}`)
        const created = parseJson<{ id?: string | number }>(res.body)
        const id = created?.id !== undefined ? String(created.id) : undefined
        rollbackState.push({ key, label, existed: false, id })
        if (id) createdIds.push(id)
      }
      deployed.push(label)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} Vault user(s) to ${pvwaUrl}: ${deployed.join(', ')}`,
      // artifacts carry usernames only — never the password.
      artifacts: { pvwaUrl, deployedUsers: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Vault user deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedUsers: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all Vault users; throws on a non-OK response. See NOTE above re: pagination. */
export async function listUsers(client: CyberArkClient): Promise<LiveVaultUser[]> {
  const res = await client.request('GET', '/Users')
  if (!res.ok) throw new Error(`Failed to list Vault users: ${cyberArkErrorMessage(res)}`)
  return parseCollectionArray<LiveVaultUser>(res.body, ['Users', 'value'])
}

/** Index Vault users by their natural key (username, lower-cased). */
export async function mapUsers(client: CyberArkClient): Promise<Map<string, LiveVaultUser>> {
  const users = await listUsers(client)
  return new Map(users.filter((u) => typeof u.username === 'string' && u.username).map((u) => [usernameKey({ username: u.username as string }), u]))
}

function contactDetails(spec: VaultUserSpec): Record<string, unknown> {
  return parseJsonObject(spec.contactDetailsJson).value ?? {}
}

/** Build the POST /Users body. The initial password is included only when supplied. */
function buildCreateBody(spec: VaultUserSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    username: spec.username,
    userType: spec.userType,
    location: spec.location,
    enableUser: spec.enableUser,
    changePassOnNextLogon: spec.changePassOnNextLogon,
    passwordNeverExpires: spec.passwordNeverExpires,
    ...contactDetails(spec),
  }
  if (spec.description) body.description = spec.description
  if (spec.authenticationMethod.length > 0) body.authenticationMethod = spec.authenticationMethod
  if (spec.vaultAuthorization.length > 0) body.vaultAuthorization = spec.vaultAuthorization
  if (spec.unauthorizedInterfaces.length > 0) body.unAuthorizedInterfaces = spec.unauthorizedInterfaces
  if (spec.expiryDate !== null) body.expiryDate = spec.expiryDate
  if (spec.initialPassword) body.initialPassword = spec.initialPassword // ⚠ write-only — create only
  return body
}

/** Build the PUT /Users/{id} body — every managed NON-SECRET field, never the password. */
function buildUpdateBody(spec: VaultUserSpec, live: LiveVaultUser): Record<string, unknown> {
  return {
    id: live.id,
    username: spec.username,
    userType: spec.userType,
    location: spec.location,
    description: spec.description,
    enableUser: spec.enableUser,
    changePassOnNextLogon: spec.changePassOnNextLogon,
    passwordNeverExpires: spec.passwordNeverExpires,
    authenticationMethod: spec.authenticationMethod,
    vaultAuthorization: spec.vaultAuthorization,
    unAuthorizedInterfaces: spec.unauthorizedInterfaces,
    expiryDate: spec.expiryDate ?? undefined,
    ...contactDetails(spec),
  }
}
