import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError, type CortexXdrClient } from '../../lib/cortexXdrApi'
import {
  ALERT_EXCLUSION_ENDPOINTS,
  buildExclusionBody,
  findExclusionByName,
  exclusionsFromReply,
  type CortexAlertExclusion,
} from './_shared'

/**
 * Deploy Cortex XDR alert exclusions over the public REST API — BEST-EFFORT.
 *   read (rollback): POST /alerts/get_alert_exclusions/     → SPECULATIVE snapshot
 *   upsert:          POST /alerts/create_alert_exclusion/   → SPECULATIVE per rule
 *
 * The Cortex XDR public API does not document alert-exclusion management, so ALL
 * of these calls are speculative and likely to 404 on a current tenant. Deploy
 * upserts by exclusion NAME. rollbackData records, per exclusion, the prior body
 * (null when it did not exist) so rollback can restore or delete if a public API
 * ever exists.
 *
 * VERIFY every endpoint path + request envelope against a live Cortex XDR tenant.
 */
async function listExclusions(client: CortexXdrClient): Promise<CortexAlertExclusion[]> {
  try {
    const res = await client.call(ALERT_EXCLUSION_ENDPOINTS.list, {})
    if (!res.ok) return []
    return exclusionsFromReply(res.reply)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for alert-exclusion deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: Array<{ name: string; prior: CortexAlertExclusion | null }> = []
  const applied: string[] = []

  try {
    const live = await listExclusions(client)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const body = buildExclusionBody(item.fields)
      previous.push({ name, prior: findExclusionByName(live, name) })

      // SPECULATIVE best-effort write — no documented public endpoint. VERIFY.
      const res = await client.call(ALERT_EXCLUSION_ENDPOINTS.create, body as Record<string, unknown>)
      const error = cortexWriteError(res)
      if (error) {
        return {
          success: false,
          message:
            `Alert-exclusion deploy failed for "${name}": ${error}. NOTE: the Cortex XDR public API does not ` +
            `document alert-exclusion management — this write is speculative and likely unsupported.`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} alert exclusion(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Alert-exclusion deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
