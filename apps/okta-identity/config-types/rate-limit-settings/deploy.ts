import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractRateLimitSpecs,
  INHERIT,
  type LiveAdminNotifications,
  type LivePerClient,
  type LiveWarningThreshold,
  type RateLimitSpec,
} from './validate'

export interface RateLimitRollbackData {
  /** Prior admin-notifications body, replayed via PUT on rollback. */
  priorAdminNotifications?: { notificationsEnabled: boolean }
  /** Prior per-client body, replayed via PUT on rollback. */
  priorPerClient?: Record<string, unknown>
  /** Prior warning-threshold body, replayed via PUT on rollback (absent if unset). */
  priorWarningThreshold?: { warningThreshold: number }
}

const ADMIN_NOTIFICATIONS_PATH = '/rate-limit-settings/admin-notifications'
const PER_CLIENT_PATH = '/rate-limit-settings/per-client'
const WARNING_THRESHOLD_PATH = '/rate-limit-settings/warning-threshold'

/**
 * Deploy the org's rate-limit settings. These are three SINGLETONS, so there is
 * no list/match — each is a GET (captured for rollback) then a PUT (full replace):
 *   - PUT /rate-limit-settings/admin-notifications
 *   - PUT /rate-limit-settings/per-client
 *   - PUT /rate-limit-settings/warning-threshold  (only when a threshold is set)
 *
 * There is no create/delete and no lifecycle. Re-applying the same canvas is a
 * no-op on Okta's side.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRateLimitSpecs(ctx.canvas)
  if (specs.length === 0) {
    return { success: false, message: 'No rate-limit configuration provided' }
  }
  const spec = specs[0]
  const applied: string[] = []

  try {
    // Capture prior state of every part this deploy touches, for rollback.
    const rollbackData: RateLimitRollbackData = {}

    const currentAdmin = await getAdminNotifications(client)
    rollbackData.priorAdminNotifications = {
      notificationsEnabled: currentAdmin?.notificationsEnabled === true,
    }
    const currentPerClient = await getPerClient(client)
    rollbackData.priorPerClient = stripReadOnly(currentPerClient ?? {})
    if (spec.warningThresholdPercent !== undefined) {
      const currentThreshold = await getWarningThreshold(client)
      if (typeof currentThreshold?.warningThreshold === 'number') {
        rollbackData.priorWarningThreshold = { warningThreshold: currentThreshold.warningThreshold }
      }
    }

    // Admin notifications — full replace.
    const adminRes = await client.request('PUT', ADMIN_NOTIFICATIONS_PATH, {
      body: buildAdminNotificationsBody(spec),
    })
    if (!adminRes.ok) {
      throw new Error(`Failed to update admin-notification settings: ${oktaErrorMessage(adminRes)}`)
    }
    applied.push('admin-notifications')

    // Per-client — full replace of default mode + overrides.
    const perClientRes = await client.request('PUT', PER_CLIENT_PATH, { body: buildPerClientBody(spec) })
    if (!perClientRes.ok) {
      throw new Error(`Failed to update per-client rate-limit settings: ${oktaErrorMessage(perClientRes)}`)
    }
    applied.push('per-client')

    // Warning threshold — only when the operator set one (it is optional).
    if (spec.warningThresholdPercent !== undefined) {
      const thresholdRes = await client.request('PUT', WARNING_THRESHOLD_PATH, {
        body: { warningThreshold: spec.warningThresholdPercent },
      })
      if (!thresholdRes.ok) {
        throw new Error(`Failed to update warning-threshold setting: ${oktaErrorMessage(thresholdRes)}`)
      }
      applied.push('warning-threshold')
    }

    return {
      success: true,
      message: `Updated rate-limit settings on Okta org at ${baseUrl}: ${applied.join(', ')}`,
      artifacts: { baseUrl, applied },
      rollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rate-limit settings deployment failed after applying ${applied.length} part(s) (${
        applied.join(', ') || 'none'
      }): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl, applied },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Read the current admin-notification settings. */
export async function getAdminNotifications(client: OktaClient): Promise<LiveAdminNotifications | null> {
  const res = await client.request('GET', ADMIN_NOTIFICATIONS_PATH)
  if (!res.ok) throw new Error(`Failed to read admin-notification settings: ${oktaErrorMessage(res)}`)
  return parseJson<LiveAdminNotifications>(res.body)
}

/** Read the current per-client rate-limit settings. */
export async function getPerClient(client: OktaClient): Promise<LivePerClient | null> {
  const res = await client.request('GET', PER_CLIENT_PATH)
  if (!res.ok) throw new Error(`Failed to read per-client rate-limit settings: ${oktaErrorMessage(res)}`)
  return parseJson<LivePerClient>(res.body)
}

/** Read the current warning-threshold setting. */
export async function getWarningThreshold(client: OktaClient): Promise<LiveWarningThreshold | null> {
  const res = await client.request('GET', WARNING_THRESHOLD_PATH)
  if (!res.ok) throw new Error(`Failed to read warning-threshold setting: ${oktaErrorMessage(res)}`)
  return parseJson<LiveWarningThreshold>(res.body)
}

/** Build the admin-notifications PUT body. */
export function buildAdminNotificationsBody(spec: RateLimitSpec): Record<string, unknown> {
  return { notificationsEnabled: spec.adminNotificationsEnabled }
}

/**
 * Build the per-client PUT body. defaultMode is always sent; a use-case override
 * is included only when it is not INHERIT (INHERIT means "omit — inherit the
 * default"). useCaseModeOverrides is always sent (empty object clears overrides)
 * so the PUT converges and drift detection agrees about the target state.
 */
export function buildPerClientBody(spec: RateLimitSpec): Record<string, unknown> {
  const overrides: Record<string, string> = {}
  if (spec.perClientLoginPageMode !== INHERIT) overrides.LOGIN_PAGE = spec.perClientLoginPageMode
  if (spec.perClientOAuth2AuthorizeMode !== INHERIT) overrides.OAUTH2_AUTHORIZE = spec.perClientOAuth2AuthorizeMode
  if (spec.perClientOIEAppIntentMode !== INHERIT) overrides.OIE_APP_INTENT = spec.perClientOIEAppIntentMode
  return { defaultMode: spec.perClientDefaultMode, useCaseModeOverrides: overrides }
}

/** Drop server-managed fields (_links) so a captured body is safe to PUT back. */
export function stripReadOnly(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === '_links') continue
    out[key] = value
  }
  return out
}
