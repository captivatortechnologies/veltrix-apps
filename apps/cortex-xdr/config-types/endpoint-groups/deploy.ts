import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError, type CortexXdrClient } from '../../lib/cortexXdrApi'
import {
  ENDPOINT_GROUP_ENDPOINTS,
  buildEndpointGroupBody,
  findGroupByName,
  groupsFromReply,
  type CortexEndpointGroup,
} from './_shared'

/**
 * Deploy Cortex XDR endpoint groups over the public REST API:
 *   read (rollback): POST /endpoints/get_endpoint_groups/  → REAL prior snapshot
 *   upsert:          POST /endpoints/create_endpoint_group/ per group  → FLAGGED
 *
 * The READ is real (get_endpoint_groups is the app's health probe). The CREATE
 * path is BEST-EFFORT / FLAGGED — the Cortex XDR public API does not document a
 * create-endpoint-group operation, so this call may 404 on a live tenant. Deploy
 * upserts by group NAME. rollbackData records, per group, the prior group body
 * (null when it did not exist) so rollback can restore or delete.
 *
 * VERIFY the create endpoint path + request envelope against a live Cortex XDR
 * tenant before relying on write.
 */
async function listGroups(client: CortexXdrClient): Promise<CortexEndpointGroup[]> {
  try {
    const res = await client.call(ENDPOINT_GROUP_ENDPOINTS.list, {})
    if (!res.ok) return []
    return groupsFromReply(res.reply)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for endpoint-group deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: Array<{ name: string; prior: CortexEndpointGroup | null }> = []
  const applied: string[] = []

  try {
    const live = await listGroups(client)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const body = buildEndpointGroupBody(item.fields)
      previous.push({ name, prior: findGroupByName(live, name) })

      // FLAGGED best-effort write — no confirmed public create endpoint. VERIFY.
      const res = await client.call(ENDPOINT_GROUP_ENDPOINTS.create, body as Record<string, unknown>)
      const error = cortexWriteError(res)
      if (error) {
        return {
          success: false,
          message:
            `Endpoint-group deploy failed for "${name}": ${error}. NOTE: the Cortex XDR public API does not ` +
            `document a create-endpoint-group endpoint — this write is best-effort and may be unsupported.`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} endpoint group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Endpoint-group deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
