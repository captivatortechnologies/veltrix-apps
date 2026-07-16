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
import {
  extractTokenSettingsSpec,
  normalizeDisabledParam,
  readLiveExpiration,
  type TokenSettingsSpec,
} from './validate'

/**
 * Deploy the stack's token-authentication SETTINGS over the Splunk Cloud
 * Platform REST API — NOT ACS, which exposes only per-token CRUD (secrets):
 *
 *   read:   GET  /services/admin/token-auth/tokens_auth
 *   apply:  POST /services/admin/token-auth/tokens_auth
 *           params: disabled=<true|false>, expiration=<relative-time>
 *
 * on https://<stack>.splunkcloud.com:8089, authenticated with a Splunk
 * authentication token (Bearer). Requires that Splunk Support has opened port
 * 8089 and that this caller's IP is on the stack's `search-api` allow list —
 * both are named in every failure message (see lib/splunkRest.ts).
 *
 * Canvas → Splunk REST parameter mapping:
 *   tokenAuthEnabled   → disabled    (INVERTED: disabled = NOT enabled)
 *   defaultExpiration  → expiration  (Splunk relative-time modifier, e.g. +30d)
 *
 * A field left blank on the canvas is NOT sent, so that setting keeps its
 * current value on the stack — this app only manages what the canvas declares.
 */

/** Single settings entity: both read and write go to this exact path. */
export const TOKEN_AUTH_SETTINGS_PATH = '/services/admin/token-auth/tokens_auth'

/** Prior settings captured for rollback (single object — settings are stack-wide). */
export interface TokenSettingsRollback {
  /** Whether the settings entity was readable before the deploy. */
  existed: boolean
  /** Prior REST parameter values, captured only when the entity existed. */
  prior?: {
    disabled?: 'true' | 'false'
    expiration?: string
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const token = resolveRestToken(ctx.credential)
  if (!token) {
    return { success: false, message: REST_TOKEN_MISSING }
  }

  const spec = extractTokenSettingsSpec(ctx.canvas)
  if (!spec) {
    return { success: false, message: 'No token-authentication settings object to deploy' }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const stack = resolveStackHost(ctx.component.hostname)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  try {
    // Capture prior state for rollback. A connection/auth failure throws here
    // rather than being mistaken for "settings entity does not exist".
    const existing = await getEntityContent(baseUrl, auth, TOKEN_AUTH_SETTINGS_PATH, timeoutMs)

    const rollback: TokenSettingsRollback = { existed: existing !== null }
    if (existing) {
      rollback.prior = {
        disabled: normalizeDisabledParam(existing.disabled),
      }
      const liveExpiration = readLiveExpiration(existing)
      if (liveExpiration !== undefined) rollback.prior.expiration = liveExpiration
    }

    const payload = buildSettingsPayload(spec)
    await postForm(baseUrl, auth, TOKEN_AUTH_SETTINGS_PATH, payload, timeoutMs)

    const applied: string[] = []
    if (spec.tokenAuthEnabled !== undefined) {
      applied.push(`token auth ${spec.tokenAuthEnabled ? 'enabled' : 'disabled'}`)
    }
    if (spec.defaultExpiration !== undefined) {
      applied.push(`default expiration ${spec.defaultExpiration}`)
    }

    return {
      success: true,
      message: `Applied token-authentication settings on stack "${stack}"${
        applied.length ? ` (${applied.join(', ')})` : ''
      }`,
      artifacts: {
        stack,
        endpoint: `${baseUrl}${TOKEN_AUTH_SETTINGS_PATH}`,
        tokenAuthEnabled: spec.tokenAuthEnabled,
        defaultExpiration: spec.defaultExpiration,
        previousState: rollback,
      },
      rollbackData: { previousState: rollback },
    }
  } catch (error) {
    return {
      success: false,
      message: `Token-authentication settings deployment to stack "${stack}" failed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { stack },
    }
  }
}

/**
 * Map the settings spec to Splunk REST parameters. Only fields the canvas
 * actually declares are included — an omitted field keeps its current value on
 * the stack. `disabled` is the inverse of `tokenAuthEnabled`.
 */
export function buildSettingsPayload(
  spec: TokenSettingsSpec,
): Record<string, string | number | boolean | string[] | undefined | null> {
  const payload: Record<string, string | number | boolean | string[] | undefined | null> = {}

  if (spec.tokenAuthEnabled !== undefined) {
    payload.disabled = spec.tokenAuthEnabled ? 'false' : 'true'
  }
  if (spec.defaultExpiration !== undefined) {
    payload.expiration = spec.defaultExpiration
  }

  return payload
}
