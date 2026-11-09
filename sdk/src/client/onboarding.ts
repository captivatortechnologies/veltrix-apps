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

/** The client-safe onboarding descriptor an app advertises in /apps/enabled. */
export interface AppOnboardingDescriptor {
  provider: string
  label: string
  /** One sentence for the connect dialog (replaces the generic sign-in text). */
  description?: string
  brokered?: boolean
  requiredSettings?: string[]
  /** Labels for `requiredSettings`, when the app declares a setting for the key. */
  requiredSettingLabels?: Record<string, string>
  /** Component type a connection from this provider is registered as (the deploy target). */
  componentType?: string
}

/**
 * Fetch an app's connection-onboarding descriptor from GET /api/apps/enabled,
 * so the Connections UI can offer an "Integrate via OAuth" option without the
 * app page having to pass it in. Returns null when the app declares no
 * onboarding (its connections stay credential-only).
 */
export async function fetchAppOnboarding(appId: string): Promise<AppOnboardingDescriptor | null> {
  return (await fetchAppOnboardings(appId))[0] ?? null
}

/** The `/apps/enabled` connection block an app advertises. */
export interface EnabledAppConnection {
  onboarding?: AppOnboardingDescriptor
  /** Every declared provider (platforms that support several per app). */
  onboardings?: AppOnboardingDescriptor[]
}

/**
 * Every onboarding provider an enabled app declares, in declaration order:
 * `connection.onboardings` when the platform advertises the list, else the
 * single `connection.onboarding` older platforms send.
 */
export function onboardingsOf(connection: EnabledAppConnection | undefined | null): AppOnboardingDescriptor[] {
  if (!connection) return []
  if (Array.isArray(connection.onboardings) && connection.onboardings.length) return connection.onboardings
  return connection.onboarding ? [connection.onboarding] : []
}

/**
 * Fetch every onboarding descriptor an app declares from GET /api/apps/enabled,
 * so the Connections UI can offer one connect button per provider. Empty when
 * the app declares none (its connections stay credential-only).
 */
export async function fetchAppOnboardings(appId: string): Promise<AppOnboardingDescriptor[]> {
  try {
    const res = await authFetch('/api/apps/enabled', { method: 'GET' })
    if (!res.ok) return []
    const data = (await res.json()) as unknown
    const list = Array.isArray(data) ? data : ((data as { data?: unknown[] })?.data ?? [])
    const app = (list as Array<{ appId?: string; id?: string; connection?: EnabledAppConnection }>).find(
      (a) => a.appId === appId || a.id === appId,
    )
    return onboardingsOf(app?.connection)
  } catch {
    return []
  }
}

export interface StartOnboardingInput {
  /** Which declared provider to use; required when the app declares several. */
  provider?: string
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

/**
 * Returned by providers that never redirect back to the platform (AWS): the
 * admin performs a step elsewhere while the page polls `completeOnboarding`.
 */
export interface OnboardPending {
  /** The one-time session token to pass to `completeOnboarding`. */
  state: string
  title: string
  instructions: string[]
  /** Copy-pasteable commands for doing the step by hand. */
  cliCommands: string[]
  /** Open `authorizeUrl` in a new tab rather than navigating away. */
  openInNewTab: boolean
  pollIntervalSeconds: number
  expiresInSeconds: number
}

export interface StartOnboardingResult {
  /**
   * Open this in the browser — the provider's hosted consent page. Empty for a
   * pending flow that offers no hosted page (manual commands only).
   */
  authorizeUrl: string
  provider: string
  /** Present when the flow finishes by polling instead of a redirect. */
  pending?: OnboardPending
}

export type CompleteOnboardingResult =
  | { status: 'done'; connectionId: string; connectionName: string; manualStepsPending: boolean }
  | { status: 'pending'; message: string }
  | { status: 'expired'; message: string }

/**
 * Poll a pending flow. POST /api/apps/:appId/connections/onboard/complete.
 * `pending` means the out-of-band step is not verifiable yet — call again
 * after `pollIntervalSeconds`; `expired` means the session is gone and the
 * admin must start over. Any other failure throws.
 */
export async function completeOnboarding(appId: string, state: string): Promise<CompleteOnboardingResult> {
  const res = await authFetch(`/api/apps/${encodeURIComponent(appId)}/connections/onboard/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  })
  if (res.ok) {
    const body = (await res.json()) as { connectionId: string; connectionName: string; manualStepsPending?: boolean }
    return { status: 'done', connectionId: body.connectionId, connectionName: body.connectionName, manualStepsPending: body.manualStepsPending ?? false }
  }
  if (res.status === 409 || res.status === 410) {
    const message = (await onboardingError(res)).message
    return { status: res.status === 409 ? 'pending' : 'expired', message }
  }
  throw await onboardingError(res)
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
        ...(input.provider ? { provider: input.provider } : {}),
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
