import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractLogStreamSpecs,
  isSplunk,
  parseConfigObject,
  type LiveLogStream,
  type LogStreamSpec,
} from './validate'

export interface LogStreamRollbackEntry {
  name: string
  existed: boolean
  /** The log-stream id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior lifecycle status (ACTIVE|INACTIVE), restored via lifecycle on rollback. */
  priorStatus?: string
  /** Prior stream body (type/name/settings, no secret), replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/** Server-managed fields Okta returns on a stream but that must never be sent back. */
export const READONLY_LOG_STREAM_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  '_links',
  // status is managed by the lifecycle endpoints, not the PUT body.
  'status',
] as const

/**
 * Deploy log streams to an Okta org via the Log Streaming API. NO UPSERT exists,
 * so for each declared stream:
 *   - GET  /logStreams          — list (paginated) and match by name
 *   - PUT  /logStreams/{id}     — update an existing stream (capture prior body)
 *   - POST /logStreams          — create a missing stream (capture the new id)
 * then reconcile the stream's lifecycle status via the activate/deactivate
 * endpoints, since status is not settable through the body.
 *
 * `type` and the whole `settings` block are WRITE-ONCE — a matched stream can only
 * be re-asserted with the same values (Okta rejects a change; the app surfaces the
 * "immutable — delete and recreate" guidance). The Splunk HEC token is WRITE-ONLY
 * and sent ONLY on create.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractLogStreamSpecs(ctx.canvas).filter((s) => s.name && s.type && s.settingsJson)
  const rollbackState: LogStreamRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const settings = spec.settingsJson ? parseConfigObject(spec.settingsJson) : null
      if (settings === null) {
        throw new Error(`Log stream "${spec.name}": settings (settingsJson) is not a valid JSON object`)
      }

      const existing = await findLogStream(client, spec.name)

      if (existing && existing.id) {
        // `type` (and all settings) are immutable — fail fast with clear guidance
        // rather than letting Okta reject the PUT with a generic writeOnce error.
        if (existing.type && spec.type !== existing.type) {
          throw new Error(
            `Log stream "${spec.name}" already exists with type "${existing.type}" — the destination type is immutable. Delete and recreate the stream to change it.`,
          )
        }

        // UPDATE IN PLACE — re-assert the (immutable) body; capture prior + status.
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          priorStatus: existing.status,
          prior: stripReadOnlyLogStreamFields(existing),
        })

        const res = await client.request('PUT', `/logStreams/${existing.id}`, {
          body: buildLogStreamBody(spec, settings, false),
        })
        if (!res.ok) {
          throw new Error(
            `Failed to update log stream "${spec.name}": ${oktaErrorMessage(res)}. Note: a stream's type and settings are immutable — delete and recreate the stream to change them.`,
          )
        }
        await reconcileStreamStatus(client, existing.id, existing.status, spec.status)
      } else {
        // A Splunk stream cannot be created without its HEC token (write-only,
        // create-only).
        if (isSplunk(spec.type) && !spec.splunkToken) {
          throw new Error(
            `Log stream "${spec.name}" is a Splunk stream but no Splunk HEC token was provided — the token is required to create the stream`,
          )
        }
        const res = await client.request('POST', '/logStreams', {
          body: buildLogStreamBody(spec, settings, true),
        })
        if (!res.ok) {
          throw new Error(`Failed to create log stream "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveLogStream>(res.body)
        if (!created?.id) {
          throw new Error(`Log stream "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
        // A newly created stream is ACTIVE; deactivate it when INACTIVE is desired.
        await reconcileStreamStatus(client, created.id, created.status ?? 'ACTIVE', spec.status)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} log stream(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedStreams: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Log stream deployment failed after ${deployed.length} of ${specs.length} stream(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedStreams: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Find a log stream by exact name across the paginated list; null when absent. */
export async function findLogStream(client: OktaClient, name: string): Promise<LiveLogStream | null> {
  const res = await client.getAll<LiveLogStream>('/logStreams')
  if (!res.ok) {
    throw new Error(
      `Failed to list log streams while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((s) => s.name === name) ?? null
}

/** Fetch a single log stream by id; null on 404. */
export async function getLogStreamById(client: OktaClient, id: string): Promise<LiveLogStream | null> {
  const res = await client.request('GET', `/logStreams/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch log stream ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveLogStream>(res.body)
}

/**
 * Build the create/update body. type/name come from the modeled fields; settings
 * come from the parsed blob with any stray `token` key stripped. The Splunk HEC
 * token (write-only) is injected into settings ONLY on create — the update
 * settings schema omits it. status is never in the body (lifecycle-managed).
 */
export function buildLogStreamBody(
  spec: LogStreamSpec,
  settings: Record<string, unknown>,
  forCreate: boolean,
): Record<string, unknown> {
  const cleanSettings: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (key !== 'token') cleanSettings[key] = value
  }
  if (forCreate && isSplunk(spec.type) && spec.splunkToken) {
    cleanSettings.token = spec.splunkToken
  }
  return { type: spec.type, name: spec.name, settings: cleanSettings }
}

/**
 * Converge a stream's lifecycle status via the activate/deactivate endpoints —
 * status is not settable through the body. No-op when already matching; a 404
 * (stream gone) is tolerated.
 */
export async function reconcileStreamStatus(
  client: OktaClient,
  streamId: string,
  currentStatus: string | undefined,
  desiredStatus: string | undefined,
): Promise<void> {
  if (!desiredStatus) return
  const desired = desiredStatus.toUpperCase()
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desired) return

  const action = desired === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `/logStreams/${streamId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} log stream ${streamId}: ${oktaErrorMessage(res)}`)
  }
}

/** Copy a live stream without server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyLogStreamFields(stream: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stream)) {
    if (!(READONLY_LOG_STREAM_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
