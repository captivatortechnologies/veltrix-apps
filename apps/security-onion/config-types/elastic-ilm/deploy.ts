import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildEsUrl, buildAuthHeader, getJson, sendJson } from '../../lib/soConsole'

/**
 * Deploy Elasticsearch ILM policies via the REST API (9200):
 *   read (rollback): GET ${esUrl}/_ilm/policy/<name>   (best-effort — 404 = new policy)
 *   apply:           PUT ${esUrl}/_ilm/policy/<name>   with a policy body from the fields
 *
 * Canvas → ILM mapping (per policy):
 *   hotMaxAgeDays             → phases.hot.actions.rollover.max_age
 *   hotMaxPrimaryShardSizeGb  → phases.hot.actions.rollover.max_primary_shard_size (optional)
 *   deleteMinAgeDays          → phases.delete.min_age (total retention)
 *
 * rollbackData records the prior policy body per name (null when the policy did
 * not exist) so rollback can PUT it back or DELETE the one we created.
 */

/** GET /_ilm/policy/<name> body: { "<name>": { policy: {...}, version, modified_date } }. */
interface IlmGetResponse {
  [name: string]: { policy?: Record<string, unknown> } | undefined
}

function buildPolicyBody(fields: Record<string, unknown>): Record<string, unknown> {
  const hotMaxAgeDays = Number(fields.hotMaxAgeDays)
  const deleteMinAgeDays = Number(fields.deleteMinAgeDays)
  const shardRaw = fields.hotMaxPrimaryShardSizeGb
  const hasShard = shardRaw !== undefined && shardRaw !== null && String(shardRaw).trim() !== ''
  const hotMaxPrimaryShardSizeGb = Number(shardRaw)

  const rollover: Record<string, unknown> = { max_age: `${hotMaxAgeDays}d` }
  if (hasShard && Number.isFinite(hotMaxPrimaryShardSizeGb) && hotMaxPrimaryShardSizeGb > 0) {
    rollover.max_primary_shard_size = `${hotMaxPrimaryShardSizeGb}gb`
  }

  return {
    policy: {
      phases: {
        hot: { min_age: '0ms', actions: { rollover } },
        delete: { min_age: `${deleteMinAgeDays}d`, actions: { delete: {} } },
      },
    },
  }
}

/** Read the live policy body (best-effort) for the rollback snapshot; null on any miss. */
async function readPolicy(esUrl: string, auth: Record<string, string>, policyName: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await getJson<IlmGetResponse>(`${esUrl}/_ilm/policy/${encodeURIComponent(policyName)}`, auth)
    return res[policyName]?.policy ?? null
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for ILM policy deployment' }
  }

  const esUrl = buildEsUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  const previous: Array<{ policyName: string; policy: Record<string, unknown> | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const policyName = String(item.fields.policyName ?? '').trim()
      if (!policyName) continue

      const existing = await readPolicy(esUrl, auth, policyName)
      previous.push({ policyName, policy: existing })

      const body = buildPolicyBody(item.fields)
      await sendJson('PUT', `${esUrl}/_ilm/policy/${encodeURIComponent(policyName)}`, auth, body)
      applied.push(policyName)
    }

    return {
      success: true,
      message: `Applied ${applied.length} ILM policy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `ILM policy deploy failed after ${applied.length} policy(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
