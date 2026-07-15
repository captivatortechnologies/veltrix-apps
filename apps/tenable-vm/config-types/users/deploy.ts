import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractUserSpecs, type LiveUser, type UserSpec } from './validate'

export interface UserRollbackEntry {
  username: string
  existed: boolean
  /** Numeric user_id returned by the API — the rollback key (never the username). */
  id?: number
  /**
   * Prior NON-SECRET state captured before an update, replayed on rollback.
   * The password is deliberately absent: Tenable never returns it, so it can be
   * neither captured nor restored.
   */
  prior?: Pick<LiveUser, 'name' | 'permissions' | 'email' | 'enabled'>
}

/**
 * Deploy user accounts to a Tenable VM tenant via the Users API.
 *
 * For each declared user:
 *   - GET  /users                 — list + find by username (capture prior state)
 *   - PUT  /users/{id}            — update existing (keyed on the numeric user_id)
 *   - POST /users                 — create missing (capture the created id)
 *   - PUT  /users/{id}/enabled    — toggle enabled state (its own endpoint)
 *
 * SECRET HANDLING: `password` is write-only in Tenable. It is REQUIRED to create
 * a new account (a create without one is rejected), and on an update it is sent
 * ONLY when the canvas supplies one (a change) — a blank password leaves the
 * existing (unreadable) password in place.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractUserSpecs(ctx.canvas).filter((s) => s.username && s.name)
  const rollbackState: UserRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findUser(client, spec.username)

      if (existing && existing.id !== undefined) {
        rollbackState.push({
          username: spec.username,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            permissions: existing.permissions,
            // email mirrors the login username; fall back to it if absent.
            email: existing.email ?? existing.username,
            enabled: existing.enabled,
          },
        })

        // Update the non-secret fields. Password is included only when the
        // canvas supplies one (see buildUpdatePayload) — never read back.
        const res = await client.request('PUT', `/users/${existing.id}`, {
          body: buildUpdatePayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update user "${spec.username}": ${tenableErrorMessage(res)}`)
        }

        // enabled lives behind its own endpoint — only toggle it when it differs.
        if (existing.enabled !== undefined && existing.enabled !== spec.enabled) {
          await setEnabled(client, existing.id, spec.enabled, spec.username)
        }
      } else {
        // CREATE requires a password (write-only; Tenable rejects a create
        // without one). validate cannot enforce this (it can't tell create from
        // update), so it is enforced here.
        if (!spec.password) {
          throw new Error(
            `User "${spec.username}" does not exist yet and no password was provided — a password is required to create a new account`,
          )
        }

        const res = await client.request('POST', '/users', { body: buildCreatePayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create user "${spec.username}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveUser>(res.body)
        const createdId = created?.id
        rollbackState.push({ username: spec.username, existed: false, id: createdId })
        if (createdId === undefined) {
          throw new Error(`User "${spec.username}" was created but the API returned no id`)
        }

        // New accounts are enabled by default — only call the endpoint to disable.
        if (spec.enabled === false) {
          await setEnabled(client, createdId, false, spec.username)
        }
      }

      deployed.push(spec.username)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} user(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedUsers: deployed },
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  } catch (error) {
    return {
      success: false,
      message: `User deployment failed after ${deployed.length} of ${specs.length} user(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedUsers: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  }
}

// --- Helpers ---

/**
 * Look up a user by username in the tenant list; null when absent.
 * Email logins are case-insensitive, so match on a lowercased username — the
 * same normalization validate uses to dedupe.
 */
export async function findUser(client: TenableClient, username: string): Promise<LiveUser | null> {
  const res = await client.request('GET', '/users')
  if (!res.ok) {
    throw new Error(`Failed to list users while resolving "${username}": ${tenableErrorMessage(res)}`)
  }
  const users = parseJson<{ users?: LiveUser[] }>(res.body)?.users ?? []
  const target = username.toLowerCase()
  return users.find((u) => (u.username ?? '').toLowerCase() === target) ?? null
}

/** Enable or disable an account through its dedicated endpoint. */
async function setEnabled(
  client: TenableClient,
  id: number,
  enabled: boolean,
  username: string,
): Promise<void> {
  const res = await client.request('PUT', `/users/${id}/enabled`, { body: { enabled } })
  if (!res.ok) {
    throw new Error(
      `Failed to ${enabled ? 'enable' : 'disable'} user "${username}": ${tenableErrorMessage(res)}`,
    )
  }
}

/**
 * Build the POST /users create body. `email` mirrors `username` (both are the
 * login email). `password` is write-only and required here — deploy guarantees
 * it is set before this is called.
 */
export function buildCreatePayload(spec: UserSpec): Record<string, unknown> {
  return {
    username: spec.username,
    name: spec.name,
    permissions: spec.permissions,
    password: spec.password,
    email: spec.username,
  }
}

/**
 * Build the PUT /users/{id} update body — NON-SECRET fields only.
 * permissions/name/email are always sent so canvas edits converge the account;
 * `password` is added ONLY when the canvas supplies one (a change), so a blank
 * password preserves the existing (unreadable) one. `enabled` is not sent here —
 * it is toggled through PUT /users/{id}/enabled.
 */
export function buildUpdatePayload(spec: UserSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    permissions: spec.permissions,
    name: spec.name,
    email: spec.username,
  }
  if (spec.password) body.password = spec.password
  return body
}
