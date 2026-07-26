import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSentinelClient,
  armErrorMessage,
  parseJson,
  SENTINEL_API_VERSION,
  type SentinelClient,
  type SentinelResponse,
} from '../../lib/sentinel'
import { connectorDataTypeStates, extractDataConnectorSpecs, type DataConnectorSpec } from './validate'

/** State captured per connector so a rollback can delete creates and restore updates. */
export interface DataConnectorRollbackEntry {
  connectorId: string
  existed: boolean
  prior?: { kind?: string; properties?: unknown }
}

/**
 * The Microsoft.SecurityInsights DataConnector request body for a spec. Each
 * enabled data type maps to { <apiKey>: { state: 'Enabled' | 'Disabled' } }.
 */
export function buildDataConnectorBody(spec: DataConnectorSpec): unknown {
  const dataTypes: Record<string, { state: 'Enabled' | 'Disabled' }> = {}
  for (const [apiKey, state] of Object.entries(connectorDataTypeStates(spec))) {
    dataTypes[apiKey] = { state }
  }
  return {
    kind: spec.kind,
    properties: {
      tenantId: spec.tenantId,
      dataTypes,
    },
  }
}

/** GET one data connector by its dataConnectorId. */
export function getDataConnector(client: SentinelClient, connectorId: string): Promise<SentinelResponse> {
  return client.request('GET', client.sentinelPath(`/dataConnectors/${connectorId}`), { apiVersion: SENTINEL_API_VERSION })
}

/**
 * Deploy data connectors via ARM. Reconciliation is by the dataConnectorId: GET
 * to learn whether it exists (and capture prior state for rollback), then PUT
 * (upsert). Connectors not declared here are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractDataConnectorSpecs(ctx.canvas).filter((s) => s.connectorId)
  const rollbackState: DataConnectorRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    for (const spec of specs) {
      const path = client.sentinelPath(`/dataConnectors/${spec.connectorId}`)
      const current = await getDataConnector(client, spec.connectorId)
      let existed = false
      if (current.status === 200) {
        existed = true
        const prior = parseJson<{ kind?: string; properties?: unknown }>(current.body)
        rollbackState.push({ connectorId: spec.connectorId, existed: true, prior: { kind: prior?.kind, properties: prior?.properties } })
      } else if (current.status === 404) {
        rollbackState.push({ connectorId: spec.connectorId, existed: false })
      } else {
        throw new Error(`Failed to read data connector "${spec.connectorId}": ${armErrorMessage(current)}`)
      }

      const res = await client.request('PUT', path, { apiVersion: SENTINEL_API_VERSION, body: buildDataConnectorBody(spec) })
      if (!res.ok) throw new Error(`Failed to ${existed ? 'update' : 'create'} data connector "${spec.connectorId}": ${armErrorMessage(res)}`)
      ;(existed ? updated : created).push(spec.connectorId)
    }

    return {
      success: true,
      message: `Data connectors deployed to ${armHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Data connector deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
