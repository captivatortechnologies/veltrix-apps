import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  DEFAULT_AUTH_HEADER_KEY,
  extractEventHookSpecs,
  normalizeHeaders,
  parseHeadersArray,
  type EventHookSpec,
  type HookHeader,
  type LiveEventHook,
} from './validate'

export interface EventHookRollbackEntry {
  name: string
  existed: boolean
  /** The event-hook id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior lifecycle status (ACTIVE|INACTIVE), restored via lifecycle on rollback. */
  priorStatus?: string
  /** Prior hook definition with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/**
 * Server-managed fields Okta returns on an event hook but that must never be sent
 * back. NOTE: channel.config.authScheme.value (the write-only secret) is NEVER
 * present on a GET, so it needs no explicit strip — but by the same token it can
 * never be restored on rollback (see rollback.ts).
 */
export const READONLY_EVENT_HOOK_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  'verificationStatus',
  '_links',
  '_embedded',
  // status is managed by the lifecycle endpoints, not the PUT body.
  'status',
] as const

/**
 * Deploy event hooks to an Okta org via the Event Hooks API. NO UPSERT exists, so
 * for each declared hook:
 *   - GET  /eventHooks          — list (paginated) and match by name
 *   - PUT  /eventHooks/{id}     — update an existing hook (capture prior body)
 *   - POST /eventHooks          — create a missing hook (born ACTIVE + UNVERIFIED)
 * then reconcile the hook's lifecycle status via the lifecycle endpoints, since
 * status is not settable through the PUT body.
 *
 * VERIFICATION is an external one-time handshake (Okta calls the endpoint with a
 * challenge). This app NEVER auto-verifies. A newly CREATED hook is unverified,
 * and any CHANNEL change on an existing hook clears its verification — both cases
 * are surfaced in the deploy message so the operator can verify out of band.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractEventHookSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: EventHookRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []
  // Hooks that need the external verify handshake before Okta will deliver events.
  const needsVerify: string[] = []

  try {
    for (const spec of specs) {
      // Re-parse here to build the API body and to fail loudly rather than send a
      // malformed headers blob. An absent blob is treated as no extra headers.
      let headers: HookHeader[] = []
      if (spec.headersJson) {
        const parsed = parseHeadersArray(spec.headersJson)
        if (parsed === null) {
          throw new Error(`Event hook "${spec.name}": headers (headersJson) is not a valid JSON array`)
        }
        headers = normalizeHeaders(parsed)
      }

      const existing = await findEventHook(client, spec.name)

      if (existing && existing.id) {
        // UPDATE IN PLACE. Capture the prior definition + status for rollback
        // (keyed on the returned id, never the name). Detect a channel change
        // BEFORE the PUT so we know whether re-verification is required.
        const channelDidChange = channelChanged(spec, headers, existing)
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          priorStatus: existing.status,
          prior: stripReadOnlyEventHookFields(existing),
        })

        const res = await client.request('PUT', `/eventHooks/${existing.id}`, {
          body: buildEventHookBody(spec, headers),
        })
        if (!res.ok) {
          throw new Error(`Failed to update event hook "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        await reconcileHookStatus(client, existing.id, existing.status, spec.status)
        if (channelDidChange) needsVerify.push(spec.name)
      } else {
        const res = await client.request('POST', '/eventHooks', {
          body: buildEventHookBody(spec, headers),
        })
        if (!res.ok) {
          throw new Error(`Failed to create event hook "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveEventHook>(res.body)
        if (!created?.id) {
          throw new Error(`Event hook "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
        // A newly created hook is ACTIVE but UNVERIFIED; deactivate when INACTIVE
        // is desired, and always flag it for the external verify handshake.
        await reconcileHookStatus(client, created.id, created.status ?? 'ACTIVE', spec.status)
        needsVerify.push(spec.name)
      }

      deployed.push(spec.name)
    }

    let message = `Deployed ${deployed.length} event hook(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`
    if (needsVerify.length > 0) {
      message +=
        `. Verification required (external one-time handshake — this app does NOT auto-verify): ${needsVerify.join(', ')}. ` +
        `New hooks are created UNVERIFIED and a channel change clears verification; Okta will not deliver events until each hook is verified ` +
        `from the Okta Admin console or via POST /eventHooks/{id}/lifecycle/verify.`
    }

    return {
      success: true,
      message,
      artifacts: { baseUrl, deployedHooks: deployed, needsVerify },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Event hook deployment failed after ${deployed.length} of ${specs.length} hook(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedHooks: deployed, needsVerify },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find an event hook by exact name across the paginated list; null when absent. */
export async function findEventHook(client: OktaClient, name: string): Promise<LiveEventHook | null> {
  const res = await client.getAll<LiveEventHook>('/eventHooks')
  if (!res.ok) {
    throw new Error(
      `Failed to list event hooks while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((h) => h.name === name) ?? null
}

/** Fetch a single event hook by id; null on 404. */
export async function getEventHookById(client: OktaClient, id: string): Promise<LiveEventHook | null> {
  const res = await client.request('GET', `/eventHooks/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch event hook ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveEventHook>(res.body)
}

/**
 * Build the create/update body. events and channel come from the modeled fields.
 * The write-only auth secret (authScheme.value) is included only when supplied —
 * it is re-asserted on every deploy since Okta never returns it for comparison.
 */
export function buildEventHookBody(spec: EventHookSpec, headers: HookHeader[]): Record<string, unknown> {
  const authScheme: Record<string, unknown> = {
    type: 'HEADER',
    key: spec.authHeaderKey || DEFAULT_AUTH_HEADER_KEY,
  }
  if (spec.authHeaderValue) authScheme.value = spec.authHeaderValue

  const config: Record<string, unknown> = { uri: spec.uri, authScheme }
  if (headers.length > 0) config.headers = headers

  return {
    name: spec.name,
    events: { type: 'EVENT_TYPE', items: spec.eventItems },
    channel: { type: 'HTTP', version: '1.0.0', config },
  }
}

/**
 * True when the desired channel differs from the live hook's channel — a change
 * that clears Okta's verification and so requires re-verification. Compares the
 * URI, the auth header KEY and the extra headers; the write-only auth VALUE is
 * excluded (it can never be read back to compare).
 */
export function channelChanged(spec: EventHookSpec, headers: HookHeader[], live: LiveEventHook): boolean {
  const liveConfig = live.channel?.config ?? {}
  if ((liveConfig.uri ?? '') !== spec.uri) return true
  const liveKey = liveConfig.authScheme?.key ?? ''
  if (liveKey !== (spec.authHeaderKey || DEFAULT_AUTH_HEADER_KEY)) return true
  const liveHeaders = Array.isArray(liveConfig.headers) ? liveConfig.headers : []
  return headersFingerprint(headers) !== headersFingerprint(liveHeaders)
}

/** Order-insensitive fingerprint of a set of {key,value} headers. */
export function headersFingerprint(headers: Array<{ key?: string; value?: string }>): string {
  return headers
    .map((h) => `${h.key ?? ''}=${h.value ?? ''}`)
    .sort()
    .join('|')
}

/**
 * Converge an event hook's lifecycle status. Okta does not change status through
 * the PUT body — you activate/deactivate via the lifecycle endpoints. No-op when
 * the desired status already matches. A 404 (hook gone) is tolerated.
 */
export async function reconcileHookStatus(
  client: OktaClient,
  hookId: string,
  currentStatus: string | undefined,
  desiredStatus: string | undefined,
): Promise<void> {
  if (!desiredStatus) return
  const desired = desiredStatus.toUpperCase()
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desired) return

  const action = desired === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `/eventHooks/${hookId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} event hook ${hookId}: ${oktaErrorMessage(res)}`)
  }
}

/** Copy a live hook without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyEventHookFields(hook: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(hook)) {
    if (!(READONLY_EVENT_HOOK_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
