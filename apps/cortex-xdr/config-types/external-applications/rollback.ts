import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError } from '../../lib/cortexXdrApi'
import { EXTERNAL_APPLICATION_BASE, type LiveExternalApplication } from './_shared'

/**
 * Undo an external-application deploy from rollbackData.previous (written by
 * deploy()): applications that existed before are RESTORED via PUT
 * .../external-application/{application_id} with their prior live snapshot;
 * applications this deploy CREATED (prior null) are DELETED via DELETE
 * .../external-application/{application_type}/id/{application_id}.
 *
 * NOTE: `connection_config` may contain provider secrets (webhook auth headers,
 * AWS access keys, Splunk HEC tokens) that Cortex XDR masks or omits on read —
 * a restore replays whatever the live snapshot returned, which may not include a
 * secret that changed; this is a known limitation, not silently hidden.
 *
 * VERIFY every endpoint path + the auth requirement against a live Cortex XDR
 * tenant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{
      name: string
      prior: LiveExternalApplication | null
      created?: { application_id: number; application_type: string }
    }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for external-application rollback' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const restores = previous.filter((p) => p.prior)
  const deletable = previous.filter((p) => !p.prior && p.created)
  const unrecoverable = previous.filter((p) => !p.prior && !p.created)

  try {
    for (const { prior } of restores) {
      const p = prior as LiveExternalApplication
      const body = {
        name: p.name,
        description: p.description,
        application_type: p.application_type,
        connection_config: p.connection_config ?? {},
      }
      const res = await client.request('PUT', `${EXTERNAL_APPLICATION_BASE}/${p.application_id}`, body)
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback restore failed: ${error}` }
    }
    for (const { created } of deletable) {
      const { application_id, application_type } = created as { application_id: number; application_type: string }
      const res = await client.request('DELETE', `${EXTERNAL_APPLICATION_BASE}/${application_type}/id/${application_id}`)
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback delete failed: ${error}` }
    }
    return {
      success: true,
      message:
        `Rolled back external applications: ${restores.length} restored, ${deletable.length} deleted.` +
        (unrecoverable.length > 0
          ? ` ${unrecoverable.length} newly-created application(s) could not be auto-deleted (create response did not include an application_id) — remove them manually via Settings > Configurations > External Applications.`
          : ''),
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
