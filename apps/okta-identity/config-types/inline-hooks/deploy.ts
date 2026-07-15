import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  CHANNEL_VERSION,
  DEFAULT_AUTH_HEADER_KEY,
  HOOK_VERSION,
  extractInlineHookSpecs,
  parseChannelConfig,
  type InlineHookSpec,
  type LiveInlineHook,
} from './validate'

export interface InlineHookRollbackEntry {
  name: string
  type: string
  existed: boolean
  /** The hook id Okta assigns — the rollback key (never the name/type). */
  id?: string
  /** Prior lifecycle status (ACTIVE|INACTIVE), restored via lifecycle on rollback. */
  priorStatus?: string
  /** Prior hook definition with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/** Server-managed fields Okta returns on a hook but that must never be sent back. */
export const READONLY_HOOK_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  'system',
  '_links',
  '_embedded',
  // status is managed by the lifecycle endpoints, not the PUT body.
  'status',
] as const

/**
 * Deploy inline hooks to an Okta org via the Inline Hooks API. NO UPSERT exists,
 * so for each declared hook (matched by the (name, type) PAIR):
 *   - GET  /inlineHooks?type={TYPE}   — list (paginated) and match by (name, type)
 *   - PUT  /inlineHooks/{id}          — update an existing hook (capture prior body)
 *   - POST /inlineHooks               — create a missing hook (capture the new id)
 * then reconcile the hook's lifecycle status (ACTIVE/INACTIVE) via the lifecycle
 * endpoints, since status is not settable through the PUT body.
 *
 * A newly created hook is born ACTIVE; it is deactivated when INACTIVE is desired.
 * The channel secret (HTTP authScheme.value / OAUTH clientSecret) is write-only —
 * Okta never returns it — so a blank value is omitted from the body to preserve
 * the stored secret. NOTE: any change to a hook's channel needs Okta to re-verify
 * the endpoint (an external handshake); this deploy never auto-calls verify.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractInlineHookSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: InlineHookRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []
  let channelChanged = false

  try {
    for (const spec of specs) {
      const label = `${spec.type}:${spec.name}`

      // Re-parse the channel config here to build the API body and to fail loudly
      // rather than send a malformed definition. An absent blob is an empty config.
      const config = spec.configJson ? parseChannelConfig(spec.configJson) : {}
      if (config === null) {
        throw new Error(`Inline hook "${label}": channel config (configJson) is not a valid JSON object`)
      }

      const existing = await findInlineHook(client, spec.name, spec.type)

      if (existing && existing.id) {
        // UPDATE IN PLACE. Capture the prior definition + status for rollback
        // (keyed on the returned id, never the (name, type)).
        rollbackState.push({
          name: spec.name,
          type: spec.type,
          existed: true,
          id: existing.id,
          priorStatus: existing.status,
          prior: stripReadOnlyHookFields(existing),
        })

        const res = await client.request('PUT', `/inlineHooks/${existing.id}`, {
          body: buildInlineHookBody(spec, config),
        })
        if (!res.ok) {
          throw new Error(`Failed to update inline hook "${label}": ${oktaErrorMessage(res)}`)
        }
        channelChanged = true
        await reconcileHookStatus(client, existing.id, existing.status, spec.status)
      } else {
        const res = await client.request('POST', '/inlineHooks', { body: buildInlineHookBody(spec, config) })
        if (!res.ok) {
          throw new Error(`Failed to create inline hook "${label}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveInlineHook>(res.body)
        if (!created?.id) {
          throw new Error(`Inline hook "${label}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, type: spec.type, existed: false, id: created.id })
        createdIds.push(created.id)
        channelChanged = true
        // A newly created hook is ACTIVE; deactivate it when INACTIVE is desired.
        await reconcileHookStatus(client, created.id, created.status ?? 'ACTIVE', spec.status)
      }

      deployed.push(label)
    }

    const verifyNote = channelChanged
      ? ' Channel endpoints must be re-verified in Okta (an external one-time handshake) before hooks fire.'
      : ''

    return {
      success: true,
      message: `Deployed ${deployed.length} inline hook(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}.${verifyNote}`,
      artifacts: { baseUrl, deployedHooks: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Inline hook deployment failed after ${deployed.length} of ${specs.length} hook(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedHooks: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * Find a hook by its (name, type) PAIR; null when absent. Lists hooks filtered by
 * type (following pagination) and matches the name exactly, so a same-named hook
 * of a different type is never adopted.
 */
export async function findInlineHook(
  client: OktaClient,
  name: string,
  type: string,
): Promise<LiveInlineHook | null> {
  const res = await client.getAll<LiveInlineHook>(`/inlineHooks?type=${encodeURIComponent(type)}`)
  if (!res.ok) {
    throw new Error(
      `Failed to list inline hooks while resolving "${type}:${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((h) => h.name === name && (h.type ?? '').toLowerCase() === type) ?? null
}

/** Fetch a single hook by id; null on 404. */
export async function getInlineHookById(client: OktaClient, id: string): Promise<LiveInlineHook | null> {
  const res = await client.request('GET', `/inlineHooks/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch inline hook ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveInlineHook>(res.body)
}

/**
 * Build the HTTP auth scheme from the modeled fields. The value is the write-only
 * secret: it is included ONLY when a non-empty value is provided, so a blank value
 * on a re-deploy preserves the secret Okta already holds rather than clearing it.
 */
export function buildAuthScheme(spec: InlineHookSpec): Record<string, unknown> {
  const scheme: Record<string, unknown> = {
    type: 'HEADER',
    key: spec.authHeaderKey || DEFAULT_AUTH_HEADER_KEY,
  }
  if (spec.authHeaderValue) scheme.value = spec.authHeaderValue
  return scheme
}

/**
 * Build the channel object. The parsed config blob is merged in first (for OAUTH:
 * clientId / clientSecret / tokenUrl / scope / authType), then the modeled fields
 * ALWAYS win — the free-form JSON can never override the endpoint or, for HTTP, the
 * header auth scheme. `method` defaults to POST and `headers` to [] when unset.
 */
export function buildChannel(spec: InlineHookSpec, config: Record<string, unknown>): Record<string, unknown> {
  const channelConfig: Record<string, unknown> = {
    ...config,
    // The modeled endpoint always wins over anything in the blob.
    uri: spec.uri,
  }
  if (channelConfig.method === undefined) channelConfig.method = 'POST'
  if (channelConfig.headers === undefined) channelConfig.headers = []

  if (spec.channelType === 'HTTP') {
    // Header auth is modeled — it wins over any authScheme in the blob.
    channelConfig.authScheme = buildAuthScheme(spec)
  }

  return { type: spec.channelType, version: CHANNEL_VERSION, config: channelConfig }
}

/**
 * Build the create/update body: name/type/version and the channel. The modeled
 * name/type always identify the hook; the channel merges the config blob with the
 * modeled endpoint/auth winning.
 */
export function buildInlineHookBody(
  spec: InlineHookSpec,
  config: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name: spec.name,
    type: spec.type,
    version: HOOK_VERSION,
    channel: buildChannel(spec, config),
  }
}

/**
 * Converge a hook's lifecycle status via the activate/deactivate endpoints (status
 * is not settable through the PUT body). No-op when the desired status already
 * matches the current one. A 404 (hook gone) is tolerated.
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
  const res = await client.request('POST', `/inlineHooks/${hookId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} inline hook ${hookId}: ${oktaErrorMessage(res)}`)
  }
}

/** Copy a live hook without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyHookFields(hook: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(hook)) {
    if (!(READONLY_HOOK_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
