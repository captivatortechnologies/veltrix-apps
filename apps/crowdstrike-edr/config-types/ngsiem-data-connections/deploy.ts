import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import {
  extractConnectionSpecs,
  hasCredential,
  liveRepository,
  liveEndpoint,
  liveStatus,
  STATUS_DISABLED,
  STATUS_ENABLED,
  type ConnectionSpec,
  type LiveDataConnection,
} from './validate'

/** Collection and entity paths for Next-Gen SIEM data connections. */
export const CONNECTION_COLLECTION = '/ngsiem/combined/connections/v1'
export const CONNECTION_ENTITY = '/ngsiem/entities/connections/v1'
export const CONNECTION_STATUS = '/ngsiem/entities/connections/status/v1'

/**
 * Rollback state for one connection. `prior` carries ONLY non-secret fields — the
 * write-only credential is never read back or stored, so a restored connection
 * keeps whatever credential it already had.
 */
export interface ConnectionRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    connector_type?: string
    parser?: string
    repository?: string
    endpoint?: string
    status?: string
    description?: string
  }
}

/**
 * Deploy data connections to a Falcon tenant via the Next-Gen SIEM connections
 * API.
 *
 * For each declared connection (identity = name):
 *   - list connections (combined) and match by name
 *   - POST  …/connections/v1            — create when absent
 *   - PATCH …/connections/v1?ids=<id>   — update when present (connector_type is create-only)
 *   - PATCH …/connections/status/v1?ids=<id> — converge enable/disable (best-effort)
 *
 * ⚠ SECRET: the upstream credential is nested in `config` and sent on create AND
 * update when supplied; it is NEVER read back, diffed, logged, or stored in
 * rollbackData / artifacts / error messages.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractConnectionSpecs(ctx.canvas).filter(
    (s) => s.name && s.connectorType && s.targetRepository,
  )
  const rollbackState: ConnectionRollbackEntry[] = []
  const deployed: string[] = []
  const statusWarnings: string[] = []

  try {
    // One list serves all lookups — the combined endpoint returns full entities.
    const live = await listDataConnections(client)

    for (const spec of specs) {
      const existing = findByName(live, spec.name)
      let id: string

      if (existing && existing.id) {
        id = existing.id
        rollbackState.push({ name: spec.name, existed: true, id, prior: priorNonSecret(existing) })

        const res = await client.request(
          'PATCH',
          `${CONNECTION_ENTITY}?ids=${encodeURIComponent(id)}`,
          { body: buildConnectionBody(spec, { forUpdate: true }) },
        )
        const patchFailure = falconFailure(res)
        if (patchFailure) {
          throw new Error(`Failed to update connection "${spec.name}": ${patchFailure}`)
        }
      } else {
        const res = await client.request('POST', CONNECTION_ENTITY, {
          body: buildConnectionBody(spec, { forUpdate: false }),
        })
        const createFailure = falconFailure(res)
        if (createFailure) {
          throw new Error(`Failed to create connection "${spec.name}": ${createFailure}`)
        }
        const created = parseEnvelope<LiveDataConnection | string>(res.body)?.resources?.[0]
        const newId = typeof created === 'string' ? created : created?.id
        rollbackState.push({ name: spec.name, existed: false, id: newId })
        if (!newId) {
          throw new Error(`Connection "${spec.name}" was created but the API returned no connection id`)
        }
        id = newId
      }

      // Enable/disable is a separate endpoint and its status enum is unverified,
      // so status convergence is best-effort — a failure here never fails the
      // deploy of the connection itself.
      const statusFailure = await setConnectionStatus(client, id, spec.enabled)
      if (statusFailure) {
        statusWarnings.push(`"${spec.name}": ${statusFailure}`)
      }

      deployed.push(spec.name)
    }

    const statusNote =
      statusWarnings.length > 0
        ? ` Enable/disable could not be applied for ${statusWarnings.length} connection(s): ${statusWarnings.join('; ')}.`
        : ''

    return {
      success: true,
      message: `Deployed ${deployed.length} data connection(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}.${statusNote}`,
      // artifacts carry names only — never the credential.
      artifacts: { baseUrl, deployedConnections: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Data connection deployment failed after ${deployed.length} of ${specs.length} connection(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedConnections: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Load every data connection. The combined endpoint returns full entities, so
 * find-by-name is done client-side (mirrors the registry sibling); the endpoint
 * has a `filter`, but paging the collection avoids a filter-field assumption.
 */
export async function listDataConnections(client: FalconClient): Promise<LiveDataConnection[]> {
  const limit = 100
  const connections: LiveDataConnection[] = []
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', CONNECTION_COLLECTION, { query: { limit, offset } })
    if (!res.ok) {
      throw new Error(`Failed to list data connections: ${falconErrorMessage(res)}`)
    }
    const page = parseEnvelope<LiveDataConnection>(res.body)?.resources ?? []
    connections.push(...page)
    if (page.length < limit) break
  }
  return connections
}

/** Find a connection by its name (exact, then a single case-insensitive match). */
export function findByName(
  connections: LiveDataConnection[],
  name: string,
): LiveDataConnection | null {
  const exact = connections.find((c) => c.name === name)
  if (exact) return exact
  const ci = connections.filter((c) => c.name?.toLowerCase() === name.toLowerCase())
  return ci.length === 1 ? ci[0] : null
}

/**
 * Build the connection request body. `connector_type` is create-only (immutable
 * after creation, like an IOC's type). Non-secret params (endpoint, repository)
 * always go in `config`; the credential is attached to `config` ONLY when
 * supplied, so a non-credential update never wipes an existing secret.
 *
 * ⚠ The precise `config` sub-keys are connector-specific and unverified — they
 * are applied optimistically and any rejection surfaces via the error envelope.
 */
export function buildConnectionBody(
  spec: ConnectionSpec,
  opts: { forUpdate: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name }
  if (!opts.forUpdate) body.connector_type = spec.connectorType
  if (spec.parser) body.parser = spec.parser

  const config = buildConnectionConfig(spec)
  if (Object.keys(config).length > 0) body.config = config

  return body
}

/** Assemble the connection `config` dict: non-secret params + the write-only secret. */
export function buildConnectionConfig(spec: ConnectionSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  if (spec.sourceEndpoint) config.endpoint = spec.sourceEndpoint
  if (spec.targetRepository) config.repository = spec.targetRepository
  if (hasCredential(spec)) config.credential = spec.credential // ⚠ write-only secret
  return config
}

/**
 * Converge a connection's enable/disable status via the dedicated status
 * endpoint. Returns the failure reason (best-effort) or null on success — the
 * status enum is unverified, so callers treat a failure as non-fatal.
 */
export async function setConnectionStatus(
  client: FalconClient,
  id: string,
  enabled: boolean,
): Promise<string | null> {
  const res = await client.request('PATCH', `${CONNECTION_STATUS}?ids=${encodeURIComponent(id)}`, {
    body: { status: enabled ? STATUS_ENABLED : STATUS_DISABLED },
  })
  return falconFailure(res)
}

/** Capture a live connection's non-secret fields for rollback (never the credential). */
export function priorNonSecret(live: LiveDataConnection): ConnectionRollbackEntry['prior'] {
  return {
    name: live.name,
    connector_type: live.connector_type,
    parser: live.parser,
    repository: liveRepository(live),
    endpoint: liveEndpoint(live),
    status: liveStatus(live),
    description: live.description,
  }
}
