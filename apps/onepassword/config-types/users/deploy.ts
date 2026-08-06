import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOnePasswordClient, buildPatchOp, parseJson, scimErrorMessage, type OnePasswordClient } from '../../lib/onePassword'
import { extractUserSpecs, type LiveUser, type UserSpec } from './validate'

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'

export interface UserRollbackEntry {
  userName: string
  /** false = deploy CREATED this user (rollback SUSPENDS it - there is no confirmed delete). */
  existed: boolean
  id?: string
  /** The user's exact live state before this deploy touched it (existing users only). */
  prior?: { active: boolean; givenName: string; familyName: string }
}

/**
 * Deploy 1Password users via the SCIM Bridge's Users API.
 *
 * ONE item = ONE user, matched on `userName` (the bridge has no upsert):
 *   - list      GET   /Users              (client.listAll, ListResponse-paginated)
 *   - create    POST  /Users              - missing users only
 *   - update    PATCH /Users/{id}         - a SCIM PatchOp replacing only the
 *     fields this canvas declares non-blank, plus `active` (always sent, to
 *     converge suspend/reactivate exactly)
 *
 * Never issues a DELETE - 1Password's own SCIM Bridge documentation
 * ("create, confirm, and suspend users") does not cover permanent deletion,
 * which is a manual, web-console-only action. Rollback of a user THIS deploy
 * created therefore suspends it rather than deleting it - see
 * README.md Coverage.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOnePasswordClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractUserSpecs(ctx.canvas).filter((s) => s.userName)
  const rollbackState: UserRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const users = await listUsers(client)

    for (const spec of specs) {
      const live = users.find((u) => (u.userName ?? '').toLowerCase() === spec.userName.toLowerCase()) ?? null

      if (!live) {
        const res = await client.request('POST', '/Users', { body: buildCreateBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create user "${spec.userName}": ${scimErrorMessage(res)}`)
        }
        const created = parseJson<LiveUser>(res.body)
        rollbackState.push({ userName: spec.userName, existed: false, id: created?.id })
      } else {
        rollbackState.push({
          userName: spec.userName,
          existed: true,
          id: live.id,
          prior: {
            active: live.active !== false,
            givenName: live.name?.givenName ?? '',
            familyName: live.name?.familyName ?? '',
          },
        })
        if (!live.id) {
          throw new Error(`User "${spec.userName}" was found but the bridge returned no id`)
        }
        const res = await client.request('PATCH', `/Users/${encodeURIComponent(live.id)}`, {
          body: buildPatchOp(buildUserOperations(spec)),
        })
        if (!res.ok) {
          throw new Error(`Failed to update user "${spec.userName}": ${scimErrorMessage(res)}`)
        }
      }

      deployed.push(spec.userName)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} user(s) to the 1Password SCIM Bridge at ${baseUrl}: ${deployed.join(', ')}.`,
      artifacts: { baseUrl, deployedUsers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `User deployment failed after ${deployed.length} of ${specs.length} user(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedUsers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers -------------------------------------------------------------------

/** List every user on the bridge, following SCIM ListResponse pagination. */
export async function listUsers(client: OnePasswordClient): Promise<LiveUser[]> {
  const res = await client.listAll<LiveUser>('/Users')
  if (!res.ok) {
    throw new Error(`Failed to list users: ${scimErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Build the POST /Users body for a brand-new user. */
export function buildCreateBody(spec: UserSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemas: [USER_SCHEMA],
    userName: spec.userName,
    emails: [{ value: spec.userName, primary: true }],
    active: spec.active,
  }
  if (spec.givenName || spec.familyName) {
    body.name = {
      ...(spec.givenName ? { givenName: spec.givenName } : {}),
      ...(spec.familyName ? { familyName: spec.familyName } : {}),
    }
  }
  return body
}

/**
 * Build the PATCH /Users/{id} Operations for an existing user. `active` is
 * ALWAYS replaced (so suspend/reactivate always converges); `name.givenName`
 * / `name.familyName` are only replaced when the canvas declares a non-blank
 * value - leaving one blank leaves that existing field untouched.
 */
export function buildUserOperations(spec: UserSpec): Array<{ op: 'replace'; path: string; value: unknown }> {
  const ops: Array<{ op: 'replace'; path: string; value: unknown }> = [{ op: 'replace', path: 'active', value: spec.active }]
  if (spec.givenName) ops.push({ op: 'replace', path: 'name.givenName', value: spec.givenName })
  if (spec.familyName) ops.push({ op: 'replace', path: 'name.familyName', value: spec.familyName })
  return ops
}
