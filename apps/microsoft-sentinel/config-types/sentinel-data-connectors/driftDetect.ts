import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { attachDriftActor, veltrixActorLogins } from '../../lib/sentinelActivityLog'
import { listDataConnectors, type LiveDataConnector } from './healthCheck'
import { connectorDataTypeStates, connectorKey, extractDataConnectorSpecs } from './validate'

/**
 * Detect drift between the deployed data connectors and the live workspace. A
 * declared connector that no longer exists is critical drift; a differing kind,
 * source tenant, or data-type state is warning drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractDataConnectorSpecs(ctx.deployedConfig).filter((s) => s.connectorId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own deploys authenticate as the app registration — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listDataConnectors(client)
    const byId = new Map<string, LiveDataConnector>()
    for (const c of live) if (c.name) byId.set(c.name.toLowerCase(), c)

    for (const spec of specs) {
      const before = diffs.length
      const resourceId = client.sentinelPath(`/dataConnectors/${spec.connectorId}`)
      const liveConnector = byId.get(connectorKey(spec.connectorId))
      if (!liveConnector) {
        diffs.push({ field: `connector:${spec.connectorId}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
        continue
      }

      if (String(spec.kind) !== String(liveConnector.kind ?? '')) {
        diffs.push({ field: `${spec.connectorId}.kind`, expected: String(spec.kind), actual: String(liveConnector.kind ?? ''), severity: 'warning' })
      }

      const props = liveConnector.properties ?? {}
      if (spec.tenantId !== (props.tenantId ?? '')) {
        diffs.push({ field: `${spec.connectorId}.tenantId`, expected: spec.tenantId, actual: props.tenantId ?? '', severity: 'warning' })
      }

      const liveTypes = props.dataTypes ?? {}
      for (const [apiKey, wantState] of Object.entries(connectorDataTypeStates(spec))) {
        const haveState = liveTypes[apiKey]?.state ?? ''
        if (wantState !== haveState) {
          diffs.push({ field: `${spec.connectorId}.dataTypes.${apiKey}`, expected: wantState, actual: haveState, severity: 'warning' })
        }
      }

      // Attribute every diff this connector produced to the last human change.
      await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
