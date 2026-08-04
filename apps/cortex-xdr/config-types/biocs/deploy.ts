import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError, type CortexXdrClient } from '../../lib/cortexXdrApi'
import { BIOC_ENDPOINTS, buildBiocFields, findBioc, biocsFromReply, type CortexBioc } from './_shared'

/**
 * Deploy Cortex XDR BIOCs over the public REST API:
 *   read (identity + rollback): POST /bioc/get/    → best-effort snapshot
 *   upsert:                     POST /bioc/insert/  with { request_data: [ <bioc>, … ] }
 *
 * /bioc/insert upserts by `rule_id` — a rule matched by name gets its rule_id
 * attached so the call updates it in place; an unmatched name creates a new
 * rule. rollbackData records, per rule, the prior body (null when it did not
 * exist) so rollback can restore the prior body or delete the one we created.
 *
 * VERIFY the insert request envelope and BIOC field names against a live
 * Cortex XDR tenant.
 */

/** Best-effort read of live BIOCs (unfiltered, paged wide) for identity matching + rollback snapshots. */
async function listBiocs(client: CortexXdrClient): Promise<CortexBioc[]> {
  try {
    const res = await client.call(BIOC_ENDPOINTS.get, { search_from: 0, search_to: 1000 })
    if (!res.ok) return []
    return biocsFromReply(res.reply)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for BIOC deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: Array<{ name: string; prior: CortexBioc | null }> = []
  const rules: CortexBioc[] = []
  const applied: string[] = []

  try {
    const live = await listBiocs(client)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const built2 = buildBiocFields(item.fields)
      const match = findBioc(live, name)
      if (match?.rule_id !== undefined) built2.rule_id = match.rule_id
      rules.push(built2)
      previous.push({ name, prior: match })
      applied.push(name)
    }

    if (rules.length === 0) {
      return { success: true, message: 'No BIOC rules to apply.', artifacts: { applied: [] }, rollbackData: { previous: [] } }
    }

    const res = await client.post(BIOC_ENDPOINTS.insert, { request_data: rules })
    const error = cortexWriteError(res)
    if (error) {
      return {
        success: false,
        message: `BIOC deploy failed: ${error}`,
        artifacts: { applied: [] },
        rollbackData: { previous },
      }
    }

    return {
      success: true,
      message: `Applied ${applied.length} BIOC rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `BIOC deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied: [] },
      rollbackData: { previous },
    }
  }
}
