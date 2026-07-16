import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  postForm,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
} from '../../lib/splunkRest'
import { extractUserSpecs, normalizeLiveList, type UserSpec } from './validate'

/**
 * Deploy user configuration to a Splunk Cloud stack over the Splunk Cloud
 * Platform REST API — NOT ACS, which cannot manage identity:
 *
 *   read:    GET  /services/authentication/users/<user>
 *   update:  POST /services/authentication/users/<user>   (roles/attributes)
 *
 * on https://<stack>.splunkcloud.com:8089, authenticated with a Splunk
 * authentication token (Bearer). Requires that Splunk Support has opened port
 * 8089 and that this caller's IP is on the stack's `search-api` allow list —
 * both are named in every failure message (see lib/splunkRest.ts).
 *
 * PASSWORDS ARE OUT OF SCOPE. The REST create form
 * (POST /services/authentication/users with name+password+roles) requires a
 * password, and storing user passwords as canvas config is a secret-handling
 * anti-pattern. This handler therefore reconciles roles/attributes for EXISTING
 * users ONLY, and never sends a password. A user that does not yet exist is a
 * hard failure with a clear message — create it in Splunk Web first.
 *
 * Canvas → Splunk REST parameter mapping:
 *   roles       → roles        (multi-value; required)
 *   email       → email
 *   realName    → realname
 *   defaultApp  → defaultApp
 *   tz          → tz
 *
 * A field left blank on the canvas is NOT sent, so the user keeps whatever it
 * already has — this app only manages what the canvas declares.
 */

export const USERS_BASE_PATH = '/services/authentication/users'

/** REST parameters snapshotted from the live user for rollback. */
const ROLLBACK_KEYS = ['roles', 'email', 'realname', 'defaultApp', 'tz'] as const

export interface UserRollbackEntry {
  name: string
  /** Always true: this app updates existing users only, it never creates them. */
  existed: boolean
  /** Prior REST parameter values, captured before the update. */
  prior?: Record<string, unknown>
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const token = resolveRestToken(ctx.credential)
  if (!token) {
    return { success: false, message: REST_TOKEN_MISSING }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const stack = resolveStackHost(ctx.component.hostname)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  const specs = extractUserSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: UserRollbackEntry[] = []
  const deployedUsers: string[] = []

  try {
    for (const spec of specs) {
      const userPath = `${USERS_BASE_PATH}/${encodeURIComponent(spec.name)}`

      // Capture prior state for rollback. A connection/auth failure throws here
      // rather than being mistaken for "user does not exist".
      const existing = await getEntityContent(baseUrl, auth, userPath, timeoutMs)

      if (!existing) {
        // Creating a user over REST requires a password, which is intentionally
        // out of scope — see the file header and canvas.yaml. Fail clearly.
        throw new Error(
          `User "${spec.name}" does not exist on the stack. This app manages roles and attributes for ` +
            'EXISTING users only — creating a user over REST requires a password, which is intentionally ' +
            'out of scope (passwords are never stored as config). Create the user in Splunk Web, then deploy ' +
            'to manage its roles.',
        )
      }

      const prior: Record<string, unknown> = {}
      for (const key of ROLLBACK_KEYS) {
        if (existing[key] !== undefined) prior[key] = existing[key]
      }
      rollbackState.push({ name: spec.name, existed: true, prior })

      await postForm(baseUrl, auth, userPath, buildUserPayload(spec), timeoutMs)
      deployedUsers.push(spec.name)
    }

    return {
      success: true,
      message: `Reconciled ${deployedUsers.length} user(s) on stack "${stack}": ${deployedUsers.join(', ')}`,
      artifacts: { stack, endpoint: `${baseUrl}${USERS_BASE_PATH}`, deployedUsers },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `User deployment to stack "${stack}" failed after ${deployedUsers.length} of ${specs.length} user(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: {
        stack,
        deployedUsers,
        failedAt: specs[deployedUsers.length]?.name,
      },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

/**
 * Map canvas fields to Splunk REST parameters. Only fields the canvas actually
 * declares are included — an omitted field is left untouched on the user. No
 * password is ever included.
 */
export function buildUserPayload(
  spec: UserSpec,
): Record<string, string | number | string[] | undefined> {
  const payload: Record<string, string | number | string[] | undefined> = {}

  if (spec.roles.length > 0) payload.roles = spec.roles
  if (spec.email !== undefined) payload.email = spec.email
  if (spec.realName !== undefined) payload.realname = spec.realName
  if (spec.defaultApp !== undefined) payload.defaultApp = spec.defaultApp
  if (spec.tz !== undefined) payload.tz = spec.tz

  return payload
}

/**
 * Rebuild a REST payload from a rollback snapshot. Splunk replaces `roles` with
 * whatever is posted, but a user MUST retain at least one role — so an empty
 * captured role list is skipped rather than sent as a clearing empty value.
 */
export function buildRestorePayload(
  prior: Record<string, unknown>,
): Record<string, string | number | string[] | undefined> {
  const payload: Record<string, string | number | string[] | undefined> = {}

  if ('roles' in prior) {
    const roles = normalizeLiveList(prior.roles)
    if (roles.length > 0) payload.roles = roles
  }

  for (const key of ['email', 'realname', 'defaultApp', 'tz'] as const) {
    const value = prior[key]
    if (value === undefined || value === null) continue
    payload[key] = String(value)
  }

  return payload
}
