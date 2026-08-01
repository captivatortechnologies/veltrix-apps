import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildClient, vqlTimeoutMs, setClientMonitoringVQL, type ClientMonitoringConfig } from './_shared'

/**
 * Undo a client-monitoring deploy by restoring the ClientEventTable snapshot taken
 * by deploy() (rollbackData.previousConfig). Applied over the gRPC API (mutual
 * TLS) with a single set_client_monitoring(). When no prior snapshot was captured
 * (the read failed at deploy time), nothing is restored — flagged best-effort.
 *
 * VERIFY against a live Velociraptor server: set_client_monitoring() value shape.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previousConfig?: ClientMonitoringConfig | null }

  if (!('previousConfig' in data)) return { success: true, message: 'Nothing to roll back.' }
  const previousConfig = data.previousConfig ?? null
  if (previousConfig == null) {
    return { success: true, message: 'No prior client-monitoring snapshot captured; nothing restored.' }
  }

  if (!credential) {
    return { success: false, message: 'Missing credential for client-monitoring rollback' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    await client.runVQL(setClientMonitoringVQL(JSON.stringify(previousConfig)), { timeoutMs })
    return { success: true, message: 'Restored the prior client monitoring configuration.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  } finally {
    await client.close().catch(() => {})
  }
}
