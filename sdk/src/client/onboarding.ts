// ========================================================================
// Connection onboarding — one-click "Connect …" flow (consent + broker).
//
// Typed surface over the platform's generic onboarding routes
// (POST /api/apps/:appId/connections/onboard/start, …/onboard/status,
// …/onboard/revoke). Framework-free; every call carries the platform's
// Authorization header via the shared `authFetch`.
//
// The flow: call `startOnboarding` → open the returned `authorizeUrl` (the
// admin consents on Microsoft's hosted page) → the platform's static callback
// persists the connection and redirects back to the Connections page with an
// `?onboarded=ok` flag. No secret is ever handled by app code.
// ========================================================================

import { authFetch } from './index'

async function onboardingError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '')
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: string; message?: string }
      const message = body?.error ?? body?.message
      if (message) return new Error(message)
    } catch {
      /* not JSON */
    }
    return new Error(text)
  }
  return new Error(`HTTP ${res.status}`)
}

export interface StartOnboardingInput {
  /** The deployment scope (environment) the new connection belongs to. */
  environmentId: string
  /** Display name for the new connection. */
  connectionName: string
  /**
   * Settings the admin supplies BEFORE consent (e.g. Sentinel's
   * subscription_id / resource_group / workspace_name, or a cloud override).
   */
  settings?: Record<string, unknown>
}

export interface StartOnboardingResult {
  /** Open this in the browser — the provider's hosted consent page. */
  authorizeUrl: string
  provider: string
}

/** Begin onboarding a connection. POST /api/apps/:appId/connections/onboard/start. */
export async function startOnboarding(
  appId: string,
  input: StartOnboardingInput,
): Promise<StartOnboardingResult> {
  const res = await authFetch(
    `/api/apps/${encodeURIComponent(appId)}/connections/onboard/start`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environmentId: input.environmentId,
        connectionName: input.connectionName,
        settings: input.settings ?? {},
      }),
    },
  )
  if (!res.ok) throw await onboardingError(res)
  return (await res.json()) as StartOnboardingResult
}

export interface OnboardingStatus {
  provider: string
  brokered: boolean
  tenantId: string | null
  cloud: string
  manualSteps: Array<{
    type: string
    title: string
    description: string
    deepLink?: string
    cliCommand?: string
    verifiable: boolean
  }>
  verify?: { effective: boolean; message: string }
}

/**
 * Read onboarding status for a connection, optionally running the verify probe
 * for pending manual steps (e.g. the Sentinel role assignment).
 * GET /api/apps/:appId/connections/:credentialId/onboard/status.
 */
export async function getOnboardingStatus(
  appId: string,
  credentialId: string,
  opts: { verify?: boolean } = {},
): Promise<OnboardingStatus> {
  const qs = opts.verify ? '?verify=1' : ''
  const res = await authFetch(
    `/api/apps/${encodeURIComponent(appId)}/connections/${encodeURIComponent(credentialId)}/onboard/status${qs}`,
  )
  if (!res.ok) throw await onboardingError(res)
  return (await res.json()) as OnboardingStatus
}

/**
 * Disconnect an onboarded connection (best-effort tenant-side teardown, then
 * delete). POST /api/apps/:appId/connections/:credentialId/onboard/revoke.
 */
export async function revokeOnboarding(
  appId: string,
  credentialId: string,
): Promise<{ cleaned: boolean; message: string }> {
  const res = await authFetch(
    `/api/apps/${encodeURIComponent(appId)}/connections/${encodeURIComponent(credentialId)}/onboard/revoke`,
    { method: 'POST' },
  )
  if (!res.ok) throw await onboardingError(res)
  return (await res.json()) as { cleaned: boolean; message: string }
}
