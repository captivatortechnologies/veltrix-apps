import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage, parseJson } from '../../lib/secretServerApi'
import {
  extractConnectorSpecs,
  searchConnectors,
  findConnectorByName,
  buildConnectorCreateBody,
  buildConnectorUpdateBody,
  connectorIdOf,
  type LiveConnector,
} from './_shared'

/**
 * One connection manager's prior state, captured for rollback. `existed`
 * distinguishes an UPDATE (restore `prior`) from a CREATE (leave the new
 * connector in place).
 */
export interface ConnectorRollbackEntry {
  name: string
  connectorId: number | null
  existed: boolean
  prior: LiveConnector | null
}

/**
 * Deploy Secret Server connection managers (Site Connectors) over the REST API
 * (/api/v1/distributed-engine/site-connector[s]):
 *   read:   GET   /distributed-engine/site-connectors  → match by name (no server-side name filter; matched client-side)
 *   create: POST  /distributed-engine/site-connector    with { data: {...} }
 *   update: PATCH /distributed-engine/site-connector/{id} with { data: { <field>: { dirty, value } } }
 *
 * Identity is name. rollbackData records, per connector, the prior body (null
 * when it did not exist) AND its id — so rollback can restore the prior body,
 * or leave a newly created connector in place (deletion is not managed by
 * this app). Never reads or writes the connector's own service-account
 * credential (see _shared.ts).
 *
 * NOTE: verified against the Delinea/Thycotic PowerShell module source;
 * verify request/response shapes against a live Secret Server 10.9.000064+.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiBase } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const specs = extractConnectorSpecs(items).filter((s) => s.name)

  const previous: ConnectorRollbackEntry[] = []
  const applied: string[] = []

  try {
    const allConnectors = await searchConnectors(client)

    for (const spec of specs) {
      const existing = findConnectorByName(allConnectors, spec.name)

      if (existing) {
        const connectorId = connectorIdOf(existing)
        if (connectorId === null) throw new Error(`Connection manager "${spec.name}" exists but has no usable id`)
        const res = await client.request('PATCH', `/distributed-engine/site-connector/${connectorId}`, { body: buildConnectorUpdateBody(spec) })
        if (!res.ok) throw new Error(`Failed to update connection manager "${spec.name}": ${secretServerErrorMessage(res)}`)
        previous.push({ name: spec.name, connectorId, existed: true, prior: existing })
      } else {
        const res = await client.request('POST', '/distributed-engine/site-connector', { body: buildConnectorCreateBody(spec) })
        if (!res.ok) throw new Error(`Failed to create connection manager "${spec.name}": ${secretServerErrorMessage(res)}`)
        const created = parseJson<LiveConnector>(res.body)
        previous.push({
          name: spec.name,
          connectorId: created ? connectorIdOf(created) : null,
          existed: false,
          prior: null,
        })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} connection manager(s) to ${apiBase}: ${applied.join(', ') || '(none)'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Connection manager deploy failed after ${applied.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  }
}
