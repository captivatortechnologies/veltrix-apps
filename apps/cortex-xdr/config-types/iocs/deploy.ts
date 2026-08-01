import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError, type CortexXdrClient } from '../../lib/cortexXdrApi'
import { IOC_ENDPOINTS, buildIocFields, findIoc, iocsFromReply, type CortexIoc } from './_shared'

/**
 * Deploy Cortex XDR indicators (IOCs) over the public REST API:
 *   read (rollback): POST /indicators/get_changes/  → best-effort prior snapshot
 *   upsert:          POST /indicators/insert_jsons/  with { request_data: [ <ioc>, … ] }
 *
 * insert_jsons upserts by the indicator VALUE — inserting an existing indicator
 * updates it — so a single bulk call reconciles every item. rollbackData records,
 * per indicator, the prior IOC body (null when it did not exist) so rollback can
 * restore the prior body or delete the one we created.
 *
 * VERIFY the insert_jsons request envelope (array vs object form) and the IOC
 * field names against a live Cortex XDR tenant.
 */

/** Best-effort read of live IOCs (from epoch 0) for identity matching + rollback snapshots. */
async function listIocs(client: CortexXdrClient): Promise<CortexIoc[]> {
  try {
    // get_changes returns indicators changed since `ts` (epoch ms). ts:0 asks for
    // everything; a tenant that rejects that simply yields no snapshot. VERIFY.
    const res = await client.call(IOC_ENDPOINTS.getChanges, { ts: 0 })
    if (!res.ok) return []
    return iocsFromReply(res.reply)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for indicator deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: Array<{ indicator: string; prior: CortexIoc | null }> = []
  const iocs: CortexIoc[] = []
  const applied: string[] = []

  try {
    const live = await listIocs(client)

    for (const item of items) {
      const indicator = String(item.fields.indicator ?? '').trim()
      if (!indicator) continue
      iocs.push(buildIocFields(item.fields))
      previous.push({ indicator, prior: findIoc(live, indicator) })
      applied.push(indicator)
    }

    if (iocs.length === 0) {
      return { success: true, message: 'No indicators to apply.', artifacts: { applied: [] }, rollbackData: { previous: [] } }
    }

    // Bulk upsert — insert_jsons takes the IOC array directly on request_data. VERIFY.
    const res = await client.post(IOC_ENDPOINTS.insert, { request_data: iocs })
    const error = cortexWriteError(res)
    if (error) {
      return {
        success: false,
        message: `Indicator deploy failed: ${error}`,
        artifacts: { applied: [] },
        rollbackData: { previous },
      }
    }

    return {
      success: true,
      message: `Applied ${applied.length} indicator(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Indicator deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied: [] },
      rollbackData: { previous },
    }
  }
}
