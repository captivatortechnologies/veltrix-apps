import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractAppSpecs,
  isProtectedAppName,
  parseJsonObject,
  type AppBlobs,
  type AppSpec,
  type LiveApp,
} from './validate'

export interface AppRollbackEntry {
  label: string
  signOnMode: string
  existed: boolean
  /** The app id Okta assigns — the rollback key (never the label). */
  id?: string
  /** Prior lifecycle status (ACTIVE|INACTIVE), restored via lifecycle on rollback. */
  priorStatus?: string
  /** Prior ACCESS_POLICY id (parsed from _links.accessPolicy) — restored if feasible. */
  priorAccessPolicyId?: string
  /**
   * Prior app definition with server-managed readOnly fields stripped, replayed
   * via PUT on rollback. NOTE: write-only credentials secrets (oauthClient
   * .client_secret, signing.*, x5c) are not present here (Okta never returns
   * them), so restoring an UPDATED OIDC/SAML app cannot replay them.
   */
  prior?: Record<string, unknown>
}

/** Server-managed fields Okta returns on an app but that must never be sent back. */
export const READONLY_APP_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  'orn',
  'features',
  'universalLogout',
  '_links',
  '_embedded',
  // status is managed by the lifecycle endpoints, not the create/update body.
  'status',
] as const

/** Partition live apps into exact (label+signOnMode) matches and label collisions. */
export interface AppMatchResult {
  /** Apps whose label AND signOnMode match — the intended targets. */
  exact: LiveApp[]
  /** Apps sharing the label but with a DIFFERENT signOnMode — cannot be converted. */
  labelConflicts: LiveApp[]
}

/**
 * Classify a list of live apps against a declared (label, signOnMode) identity.
 * label is matched exactly and signOnMode case-insensitively. Exposed for
 * testing; deploy / drift / healthCheck resolve a single match through findApp.
 */
export function classifyAppMatches(items: LiveApp[], label: string, signOnMode: string): AppMatchResult {
  const mode = signOnMode.toUpperCase()
  const exact: LiveApp[] = []
  const labelConflicts: LiveApp[] = []
  for (const item of items) {
    if (item.label !== label) continue
    if ((item.signOnMode ?? '').toUpperCase() === mode) exact.push(item)
    else labelConflicts.push(item)
  }
  return { exact, labelConflicts }
}

/**
 * Deploy application instances to an Okta org via the Apps API. NO UPSERT exists,
 * and an app's label is NOT unique and NOT filterable, so for each declared app:
 *   - GET  /apps?q={label}      — list (paginated, label-narrowed) and match
 *                                 EXACTLY on label + signOnMode
 *   - PUT  /apps/{id}           — FULL-replace an existing app (capture prior body)
 *   - POST /apps?activate=…     — create a missing app (capture the new id + the
 *                                 write-only client_id/client_secret it returns)
 * then reconcile lifecycle status and, when set, associate an ACCESS_POLICY.
 *
 * Guards: an ambiguous multi-match FAILS (label is not unique); a label match
 * with a different signOnMode FAILS (name + signOnMode are immutable — an app
 * cannot be converted); PROTECTED Okta system apps are never touched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAppSpecs(ctx.canvas).filter((s) => s.label && s.signOnMode)
  const rollbackState: AppRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []
  // Write-only secrets Okta returns ONLY on the create response — captured here
  // because they can never be read back (excluded from drift; not in rollback).
  const capturedCredentials: Array<{ label: string; signOnMode: string; client_id?: string; client_secret?: string }> = []

  try {
    for (const spec of specs) {
      const blobs = parseAppBlobs(spec)
      const existing = await findApp(client, spec.label, spec.signOnMode)

      if (existing && existing.id) {
        // A PROTECTED system app must never be modified. validate rejects these
        // names; this is a defensive backstop against a live match.
        if (isProtectedAppName(existing.name)) {
          throw new Error(
            `App "${spec.label}" resolves to protected Okta system app "${existing.name}" — it is managed by Okta and may not be modified.`,
          )
        }

        // UPDATE IN PLACE (full replace). Capture the prior definition, status and
        // access policy for rollback (keyed on the returned id, never the label).
        rollbackState.push({
          label: spec.label,
          signOnMode: spec.signOnMode,
          existed: true,
          id: existing.id,
          priorStatus: existing.status,
          priorAccessPolicyId: extractAccessPolicyId(existing),
          prior: stripReadOnlyAppFields(existing),
        })

        const res = await client.request('PUT', `/apps/${existing.id}`, { body: buildAppBody(spec, blobs) })
        if (!res.ok) {
          throw new Error(`Failed to update app "${spec.label}": ${oktaErrorMessage(res)}`)
        }
        await reconcileAppStatus(client, existing.id, existing.status, spec.status)
        await associateAccessPolicy(client, existing.id, spec.accessPolicyId)
      } else {
        // CREATE. A protected name must never be created (validate blocks it).
        if (isProtectedAppName(spec.name)) {
          throw new Error(`App "${spec.label}" uses protected Okta system app name "${spec.name}" and cannot be created.`)
        }
        const activate = spec.status !== 'INACTIVE'
        const res = await client.request('POST', '/apps', { query: { activate }, body: buildAppBody(spec, blobs) })
        if (!res.ok) {
          throw new Error(`Failed to create app "${spec.label}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveApp>(res.body)
        if (!created?.id) {
          throw new Error(`App "${spec.label}" was created but the API returned no id`)
        }
        rollbackState.push({ label: spec.label, signOnMode: spec.signOnMode, existed: false, id: created.id })
        createdIds.push(created.id)

        // Capture the OIDC client_id / client_secret — returned ONLY here.
        const oauthClient = (created.credentials?.oauthClient ?? {}) as Record<string, unknown>
        if (typeof oauthClient.client_id === 'string' || typeof oauthClient.client_secret === 'string') {
          capturedCredentials.push({
            label: spec.label,
            signOnMode: spec.signOnMode,
            client_id: typeof oauthClient.client_id === 'string' ? oauthClient.client_id : undefined,
            client_secret: typeof oauthClient.client_secret === 'string' ? oauthClient.client_secret : undefined,
          })
        }

        // ?activate already set the status; reconcile is a no-op backstop.
        await reconcileAppStatus(client, created.id, created.status ?? (activate ? 'ACTIVE' : 'INACTIVE'), spec.status)
        await associateAccessPolicy(client, created.id, spec.accessPolicyId)
      }

      deployed.push(spec.label)
    }

    const secretNote = capturedCredentials.length
      ? ' Captured OIDC client credentials for newly created apps in artifacts — Okta returns the client secret only once, on create.'
      : ''
    return {
      success: true,
      message: `Deployed ${deployed.length} application(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}.${secretNote}`,
      artifacts: { baseUrl, deployedApps: deployed, capturedCredentials },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `App deployment failed after ${deployed.length} of ${specs.length} application(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedApps: deployed, capturedCredentials },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Parse the JSON blobs for an app, failing loudly rather than sending garbage. */
export function parseAppBlobs(spec: AppSpec): AppBlobs {
  const blobs: AppBlobs = {}
  const parse = (raw: string | undefined, field: string): Record<string, unknown> | undefined => {
    if (!raw) return undefined
    const parsed = parseJsonObject(raw)
    if (parsed === null) {
      throw new Error(`App "${spec.label}": ${field} is not a valid JSON object`)
    }
    return parsed
  }
  blobs.settings = parse(spec.settingsJson, 'settings (settingsJson)')
  blobs.credentials = parse(spec.credentialsJson, 'credentials (credentialsJson)')
  blobs.visibility = parse(spec.visibilityJson, 'visibility (visibilityJson)')
  blobs.accessibility = parse(spec.accessibilityJson, 'accessibility (accessibilityJson)')
  blobs.profile = parse(spec.profileJson, 'profile (profileJson)')
  return blobs
}

/**
 * Resolve a single live app for a declared (label, signOnMode). label is NOT
 * unique and NOT filterable, so this narrows server-side with ?q={label}
 * (startsWith) then matches EXACTLY on label + signOnMode client-side:
 *   - >1 exact match           → FAIL (ambiguous — label is not unique)
 *   - exactly 1 exact match    → return it
 *   - 0 exact, but a label collision on a different signOnMode → FAIL (name +
 *     signOnMode are immutable, so the app cannot be converted)
 *   - 0 matches                → null (create)
 */
export async function findApp(client: OktaClient, label: string, signOnMode: string): Promise<LiveApp | null> {
  const res = await client.getAll<LiveApp>(`/apps?q=${encodeURIComponent(label)}`)
  if (!res.ok) {
    throw new Error(
      `Failed to list apps while resolving "${label}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }

  const { exact, labelConflicts } = classifyAppMatches(res.items, label, signOnMode)
  if (exact.length > 1) {
    throw new Error(
      `Ambiguous match: ${exact.length} Okta apps have the label "${label}" and sign-on mode ${signOnMode} — an app label is not unique. Resolve the duplicates in Okta before deploying. [ambiguous_match]`,
    )
  }
  if (exact.length === 1) return exact[0]
  if (labelConflicts.length > 0) {
    const modes = [...new Set(labelConflicts.map((a) => a.signOnMode ?? 'unknown'))].join(', ')
    throw new Error(
      `App "${label}" already exists with a different sign-on mode (${modes}), not ${signOnMode}. name and signOnMode are immutable, so the app cannot be converted — use a distinct label.`,
    )
  }
  return null
}

/** Fetch a single app by id; null on 404. */
export async function getAppById(client: OktaClient, id: string): Promise<LiveApp | null> {
  const res = await client.request('GET', `/apps/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch app ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveApp>(res.body)
}

/**
 * Build the create/update body. label + signOnMode come from the modeled fields
 * and always win — the free-form JSON blobs can never override the app's
 * identity. name is included only when set (Okta auto-assigns it otherwise).
 * status is NOT sent here; it is reconciled via the lifecycle endpoints.
 */
export function buildAppBody(spec: AppSpec, blobs: AppBlobs): Record<string, unknown> {
  const body: Record<string, unknown> = { label: spec.label, signOnMode: spec.signOnMode }
  if (spec.name) body.name = spec.name
  if (blobs.settings) body.settings = blobs.settings
  if (blobs.credentials) body.credentials = blobs.credentials
  if (blobs.visibility) body.visibility = blobs.visibility
  if (blobs.accessibility) body.accessibility = blobs.accessibility
  if (blobs.profile) body.profile = blobs.profile
  return body
}

/**
 * Converge an app's lifecycle status via the activate/deactivate endpoints (Okta
 * does not change status through the create/update body). No-op when already at
 * the desired status. A 404 (app gone) is tolerated.
 */
export async function reconcileAppStatus(
  client: OktaClient,
  appId: string,
  currentStatus: string | undefined,
  desiredStatus: string | undefined,
): Promise<void> {
  if (!desiredStatus) return
  const desired = desiredStatus.toUpperCase()
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desired) return

  const action = desired === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `/apps/${appId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} app ${appId}: ${oktaErrorMessage(res)}`)
  }
}

/**
 * Associate an app with an ACCESS_POLICY (owned by the policies config type):
 * PUT /apps/{appId}/policies/{accessPolicyId} with an empty body. No-op when no
 * policy is declared. Requires Okta Identity Engine (OIE); this endpoint is
 * LIMITED GA, so a failure is surfaced with that context.
 */
export async function associateAccessPolicy(
  client: OktaClient,
  appId: string,
  accessPolicyId: string | undefined,
): Promise<void> {
  if (!accessPolicyId) return
  const res = await client.request('PUT', `/apps/${appId}/policies/${accessPolicyId}`)
  if (!res.ok) {
    throw new Error(
      `Failed to associate app ${appId} with access policy ${accessPolicyId}: ${oktaErrorMessage(res)}. This requires Okta Identity Engine (OIE); the app-to-policy endpoint is LIMITED GA and the policy must be an ACCESS_POLICY that already exists.`,
    )
  }
}

/** Parse the current ACCESS_POLICY id from an app's _links.accessPolicy href, if any. */
export function extractAccessPolicyId(app: LiveApp): string | undefined {
  const links = app._links as { accessPolicy?: { href?: unknown } } | undefined
  const href = links?.accessPolicy?.href
  if (typeof href !== 'string') return undefined
  const match = href.match(/\/policies\/([^/?#]+)/)
  return match ? match[1] : undefined
}

/** Copy a live app without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyAppFields(app: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(app)) {
    if (!(READONLY_APP_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
