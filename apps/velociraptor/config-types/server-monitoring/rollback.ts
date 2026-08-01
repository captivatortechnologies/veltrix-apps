import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildClient, vqlTimeoutMs, setServerMonitoringVQL, type ServerMonitoringConfig } from './_shared'

/**
 * Undo a server-monitoring deploy by restoring the ServerMonitoringTable snapshot
 * taken by deploy() (rollbackData.previousConfig). Applied over the gRPC API
 * (mutual TLS) with a single set_server_monitoring(). When no prior snapshot was
 * captured, nothing is restored — flagged best-effort.
 *
 * VERIFY against a live Velociraptor server: set_server_monitoring() value shape.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previousConfig?: ServerMonitoringConfig | null }

  if (!('previousConfig' in data)) return { success: true, message: 'Nothing to roll back.' }
  const previousConfig = data.previousConfig ?? null
  if (previousConfig == null) {
    return { success: true, message: 'No prior server-monitoring snapshot captured; nothing restored.' }
  }

  if (!credential) {
    return { success: false, message: 'Missing credential for server-monitoring rollback' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    await client.runVQL(setServerMonitoringVQL(JSON.stringify(previousConfig)), { timeoutMs })
    return { success: true, message: 'Restored the prior server monitoring configuration.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  } finally {
    await client.close().catch(() => {})
  }
}
