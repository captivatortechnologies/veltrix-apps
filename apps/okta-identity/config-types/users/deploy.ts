import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, parseJson, oktaErrorMessage, type OktaClient } from '../../lib/okta'
import {
  extractUserSpecs,
  ACTIVE_LIKE_STATUSES,
  type UserSpec,
  type UserStatus,
  type LiveUser,
} from './validate'

export interface UserRollbackEntry {
  login: string
  existed: boolean
  id?: string
  /** Prior profile + live status, captured before an update so rollback can restore it. */
  prior?: { profile: Record<string, unknown>; status: string }
}

/**
 * Deploy a CONTROLLED set of Okta users via the Users API. Safe-by-design:
 *   - Only users declared in the canvas are managed (matched by stored id, then
 *     by login). A user NOT in the canvas is NEVER read or written.
 *   - Users are NEVER deleted. The strongest action is deactivate (DEPROVISIONED),
 *     and only when an item's desired status is DEACTIVATED.
 *
 * Per user: create (STAGED) when absent, update the profile when present, then
 * reconcile the lifecycle toward the desired status (activate / unsuspend /
 * suspend / deactivate). Prior profile + status are captured for rollback, and
 * item-id -> okta-id is carried forward (rename-safe: a login change still
 * updates the same user).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractUserSpecs(ctx.canvas).filter((s) => s.login)
  const rollbackState: UserRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []
  const warnings: string[] = []
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    for (const spec of specs) {
      // Match order: (1) the id stored for this item last deploy — rename-safe, a
      // login change still updates the SAME user; (2) by login for the first
      // deploy / items whose stored id no longer resolves.
      let existing: LiveUser | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getUserById(client, priorId)
      if (!existing) existing = await getUserByLogin(client, spec.login)

      let userId: string
      let liveStatus: string

      if (existing?.id) {
        userId = existing.id
        rollbackState.push({
          login: spec.login,
          existed: true,
          id: userId,
          prior: { profile: { ...(existing.profile ?? {}) }, status: existing.status ?? 'STAGED' },
        })
        // Partial profile update (Okta merges the sent profile).
        const res = await client.request('POST', `/users/${encodeURIComponent(userId)}`, {
          body: buildProfileBody(spec),
        })
        if (!res.ok) throw new Error(`Failed to update user "${spec.login}": ${oktaErrorMessage(res)}`)
        liveStatus = existing.status ?? 'STAGED'
      } else {
        // Create STAGED (activate=false); the lifecycle reconcile below moves it
        // to the desired state. Never create ACTIVE implicitly.
        const res = await client.request('POST', '/users?activate=false', { body: buildProfileBody(spec) })
        if (!res.ok) throw new Error(`Failed to create user "${spec.login}": ${oktaErrorMessage(res)}`)
        const created = parseJson<LiveUser>(res.body)
        if (!created?.id) throw new Error(`User "${spec.login}" was created but the API returned no id`)
        userId = created.id
        liveStatus = created.status ?? 'STAGED'
        createdIds.push(userId)
        rollbackState.push({ login: spec.login, existed: false, id: userId })
      }

      if (spec.itemId) resourceIds[spec.itemId] = userId

      const warn = await reconcileLifecycle(client, userId, spec.login, liveStatus, spec.status, spec.sendActivationEmail)
      if (warn) warnings.push(warn)

      deployed.push(spec.login)
    }

    return {
      success: true,
      message:
        `Deployed ${deployed.length} user(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}` +
        (warnings.length ? ` — ${warnings.length} warning(s): ${warnings.join('; ')}` : ''),
      artifacts: { baseUrl, deployedUsers: deployed, warnings },
      rollbackData: { previousState: rollbackState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `User deployment failed after ${deployed.length} of ${specs.length} user(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedUsers: deployed },
      rollbackData: {
        previousState: rollbackState,
        createdIds,
        resourceIds: { ...priorResourceIds, ...resourceIds },
      },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Fetch a user by Okta id; null on 404 / any non-ok. */
export async function getUserById(client: OktaClient, id: string): Promise<LiveUser | null> {
  const res = await client.request('GET', `/users/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  return parseJson<LiveUser>(res.body)
}

/** Fetch a user by login (Okta accepts the login in the id path position). */
export async function getUserByLogin(client: OktaClient, login: string): Promise<LiveUser | null> {
  const res = await client.request('GET', `/users/${encodeURIComponent(login)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to look up user "${login}": ${oktaErrorMessage(res)}`)
  return parseJson<LiveUser>(res.body)
}

/** Read the item-id -> user-id map stored on the last SUCCEEDED deploy. */
async function readPriorResourceIds(ctx: DeployContext): Promise<Record<string, string>> {
  try {
    const prior = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const rb = prior?.rollbackData as { resourceIds?: Record<string, string> } | undefined
    return rb?.resourceIds ?? {}
  } catch {
    return {}
  }
}

/** Build the { profile } body. Optional attributes are sent as null when empty so
 *  a partial update converges (clearing a field removes it). */
export function buildProfileBody(spec: UserSpec): Record<string, unknown> {
  return {
    profile: {
      login: spec.login,
      email: spec.email,
      firstName: spec.firstName,
      lastName: spec.lastName,
      displayName: spec.displayName ?? null,
      title: spec.title ?? null,
      department: spec.department ?? null,
      mobilePhone: spec.mobilePhone ?? null,
      secondEmail: spec.secondEmail ?? null,
    },
  }
}

async function lifecycle(client: OktaClient, userId: string, action: string, login: string, query?: Record<string, string>): Promise<void> {
  const res = await client.request('POST', `/users/${encodeURIComponent(userId)}/lifecycle/${action}`, { query })
  // 404 on a transition = the user is already in that state; treat as done.
  if (res.status === 404) return
  if (!res.ok) throw new Error(`Failed to ${action} user "${login}": ${oktaErrorMessage(res)}`)
}

/**
 * Move ONE declared user toward its desired status. Returns a warning string for
 * a transition that can't be applied safely (rather than forcing an aggressive
 * multi-step change), else null. Never deletes.
 */
export async function reconcileLifecycle(
  client: OktaClient,
  userId: string,
  login: string,
  current: string,
  desired: UserStatus,
  sendActivationEmail: boolean,
): Promise<string | null> {
  const activeLike = ACTIVE_LIKE_STATUSES.includes(current)

  switch (desired) {
    case 'STAGED':
      // Create-only state — Okta can't downgrade a live user back to STAGED.
      if (current !== 'STAGED') {
        return `"${login}" is ${current}; STAGED is only the initial create state and cannot be re-applied to a live user`
      }
      return null

    case 'ACTIVE':
      if (activeLike) return null
      if (current === 'SUSPENDED') {
        await lifecycle(client, userId, 'unsuspend', login)
        return null
      }
      // STAGED or DEPROVISIONED -> activate.
      await lifecycle(client, userId, 'activate', login, { sendEmail: String(sendActivationEmail) })
      return null

    case 'SUSPENDED':
      if (current === 'SUSPENDED') return null
      if (activeLike) {
        await lifecycle(client, userId, 'suspend', login)
        return null
      }
      return `"${login}" is ${current} and cannot be suspended directly — set it ACTIVE first, then SUSPENDED`

    case 'DEACTIVATED':
      if (current === 'DEPROVISIONED') return null
      await lifecycle(client, userId, 'deactivate', login)
      return null
  }
}
