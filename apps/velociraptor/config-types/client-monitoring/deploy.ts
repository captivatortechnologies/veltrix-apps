import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'
import {
  buildClient,
  vqlTimeoutMs,
  readClientMonitoring,
  mergeClientMonitoring,
  setClientMonitoringVQL,
  GET_CLIENT_MONITORING_VQL,
  ALL_CLIENTS_LABEL,
  type ClientMonitoringConfig,
  type MonitoringGroup,
} from './_shared'

/**
 * Deploy Velociraptor client monitoring over the gRPC API (mutual TLS):
 *   read (rollback base): SELECT get_client_monitoring()               — prior table
 *   set (idempotent):     SELECT set_client_monitoring(value=<merged>) — one write
 *
 * The full prior ClientEventTable is snapshotted into rollbackData so rollback can
 * restore it verbatim. Each authored group upserts by its label; the merge is
 * applied in-memory and written once.
 *
 * VERIFY against a live Velociraptor server: get_client_monitoring() /
 * set_client_monitoring() and the ClientEventTable value shape (see ./_shared.ts).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for client-monitoring deployment' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    let previousConfig: ClientMonitoringConfig | null = null
    try {
      previousConfig = readClientMonitoring(await client.runVQL(GET_CLIENT_MONITORING_VQL, { timeoutMs }))
    } catch {
      previousConfig = null // best-effort: without prior state, rollback has nothing to restore
    }

    const groups: MonitoringGroup[] = items.map((item) => ({
      label: String(item.fields.label ?? '').trim() || ALL_CLIENTS_LABEL,
      artifacts: splitList(item.fields.artifacts),
      enabled: asBool(item.fields.enabled, true),
    }))

    const merged = mergeClientMonitoring(previousConfig, groups)
    await client.runVQL(setClientMonitoringVQL(JSON.stringify(merged)), { timeoutMs })

    const applied = groups.map((g) => g.label)
    return {
      success: true,
      message: `Applied client monitoring for ${applied.length} label group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousConfig },
    }
  } catch (error) {
    return {
      success: false,
      message: `Client-monitoring deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      rollbackData: { previousConfig: null },
    }
  } finally {
    await client.close().catch(() => {})
  }
}
