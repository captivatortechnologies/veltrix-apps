import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'
import {
  buildClient,
  vqlTimeoutMs,
  readServerMonitoring,
  buildServerMonitoring,
  setServerMonitoringVQL,
  GET_SERVER_MONITORING_VQL,
  type ServerMonitoringConfig,
} from './_shared'

/**
 * Deploy Velociraptor server monitoring over the gRPC API (mutual TLS):
 *   read (rollback base): SELECT get_server_monitoring()               — prior table
 *   set (idempotent):     SELECT set_server_monitoring(value=<merged>) — one write
 *
 * Singleton: the first (only) item carries the server event-artifact list. The
 * full prior ServerMonitoringTable is snapshotted into rollbackData for restore.
 *
 * VERIFY against a live Velociraptor server: get_server_monitoring() /
 * set_server_monitoring() and the ServerMonitoringTable value shape (see ./_shared.ts).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]

  if (!credential) {
    return { success: false, message: 'Missing credential for server-monitoring deployment' }
  }
  if (!item) {
    return { success: false, message: 'No server-monitoring configuration to apply' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    let previousConfig: ServerMonitoringConfig | null = null
    try {
      previousConfig = readServerMonitoring(await client.runVQL(GET_SERVER_MONITORING_VQL, { timeoutMs }))
    } catch {
      previousConfig = null // best-effort: without prior state, rollback has nothing to restore
    }

    const artifacts = splitList(item.fields.artifacts)
    const enabled = asBool(item.fields.enabled, true)
    const merged = buildServerMonitoring(previousConfig, artifacts, enabled)
    await client.runVQL(setServerMonitoringVQL(JSON.stringify(merged)), { timeoutMs })

    return {
      success: true,
      message: enabled
        ? `Applied server monitoring: ${artifacts.length} server event artifact(s).`
        : 'Cleared server monitoring (disabled).',
      artifacts: { applied: enabled ? artifacts : [] },
      rollbackData: { previousConfig },
    }
  } catch (error) {
    return {
      success: false,
      message: `Server-monitoring deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      rollbackData: { previousConfig: null },
    }
  } finally {
    await client.close().catch(() => {})
  }
}
