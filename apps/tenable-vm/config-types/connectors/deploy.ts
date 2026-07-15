import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import {
  extractConnectorSpecs,
  parseParamsObject,
  type ConnectorSpec,
  type LiveConnector,
} from './validate'

export interface ConnectorRollbackEntry {
  name: string
  existed: boolean
  /** The uuid the API returns as `id` — the rollback key (never the name). */
  id?: string
  /**
   * Prior NON-SECRET state captured before an update, replayed on rollback.
   * `params` are deliberately absent: they are write-only in Tenable and never
   * returned on GET, so a prior secret can never be captured or restored.
   */
  prior?: Pick<LiveConnector, 'name' | 'type' | 'network_id' | 'schedule'>
}

/**
 * Deploy cloud connectors to a Tenable VM tenant via the Connectors API.
 *
 * For each declared connector:
 *   - GET  /settings/connectors        — list + find by name (capture prior state)
 *   - PUT  /settings/connectors/{id}   — update existing (keyed on the returned id)
 *   - POST /settings/connectors        — create missing (capture the created id)
 *
 * The create/update body is WRAPPED in a top-level "connector" object (see
 * buildConnectorBody). `params` carry the cloud credentials and are SECRET —
 * they are re-sent on every deploy but never read back, drift-checked or
 * restored. Names are matched exactly to decide create-vs-update, and rollback
 * is keyed on the id the API returns — never on the name.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractConnectorSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: ConnectorRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // params are validated upstream; re-parse here to build the API body and
      // to fail loudly rather than send a malformed credentials blob.
      const params = spec.paramsJson ? parseParamsObject(spec.paramsJson) : null
      if (!params) {
        throw new Error(`Connector "${spec.name}": params are missing or not a valid JSON object`)
      }

      const existing = await findConnector(client, spec.name)

      if (existing && existing.id !== undefined) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          // Only NON-SECRET fields — params can never be read back from Tenable.
          prior: {
            name: existing.name,
            type: existing.type,
            network_id: existing.network_id,
            schedule: existing.schedule ?? null,
          },
        })

        const res = await client.request('PUT', `/settings/connectors/${existing.id}`, {
          body: buildConnectorBody(spec, params),
        })
        if (!res.ok) {
          throw new Error(`Failed to update connector "${spec.name}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/settings/connectors', {
          body: buildConnectorBody(spec, params),
        })
        if (!res.ok) {
          throw new Error(`Failed to create connector "${spec.name}": ${tenableErrorMessage(res)}`)
        }
        const created = parseConnectorId(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: created })
        if (created === undefined) {
          throw new Error(`Connector "${spec.name}" was created but the API returned no id`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} connector(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedConnectors: deployed },
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  } catch (error) {
    return {
      success: false,
      message: `Connector deployment failed after ${deployed.length} of ${specs.length} connector(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedConnectors: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  }
}

// --- Helpers ---

/** Look up a connector by exact name in the tenant list; null when absent. */
export async function findConnector(
  client: TenableClient,
  name: string,
): Promise<LiveConnector | null> {
  const res = await client.request('GET', '/settings/connectors')
  if (!res.ok) {
    throw new Error(`Failed to list connectors while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const connectors = parseJson<{ connectors?: LiveConnector[] }>(res.body)?.connectors ?? []
  // Match the first exact name. Rollback is keyed on the returned id, so an
  // ambiguous name still reverts precisely.
  return connectors.find((c) => c.name === name) ?? null
}

/** Extract the connector id from a create response, tolerating the wrapper. */
function parseConnectorId(body: string): string | undefined {
  // A create may echo the connector bare or wrapped in a "connector" envelope,
  // mirroring the request shape — accept either.
  const parsed = parseJson<{ id?: string; connector?: { id?: string } }>(body)
  return parsed?.connector?.id ?? parsed?.id
}

/**
 * Build the schedule object, or undefined when no interval is configured.
 * schedule is `{ units, value }`; units default to hours when a value is set.
 */
export function buildSchedule(spec: ConnectorSpec): Record<string, unknown> | undefined {
  if (spec.scheduleValue === undefined) return undefined
  return { units: spec.scheduleUnits ?? 'hours', value: spec.scheduleValue }
}

/**
 * Build the create/update request body — WRAPPED in a top-level "connector"
 * object, as the Tenable Connectors API requires:
 *   { "connector": { name, type, params, schedule?, network_uuid? } }
 * `params` (the write-only cloud credentials) are always sent; schedule and
 * network_uuid are omitted when not configured.
 */
export function buildConnectorBody(
  spec: ConnectorSpec,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const connector: Record<string, unknown> = {
    name: spec.name,
    type: spec.type,
    params,
  }
  const schedule = buildSchedule(spec)
  if (schedule) connector.schedule = schedule
  // The API create/update field is `network_uuid`; a GET echoes it as `network_id`.
  if (spec.networkUuid) connector.network_uuid = spec.networkUuid
  return { connector }
}
