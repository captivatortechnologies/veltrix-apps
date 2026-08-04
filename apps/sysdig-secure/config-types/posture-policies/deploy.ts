import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigClient, type SysdigPosturePolicy, type SysdigPosturePolicySummary } from '../../lib/sysdigApi'
import { buildPolicyBody, findPolicySummaryByName, normalizeBoolean } from './_shared'

/**
 * Deploy Sysdig Secure posture policies over the REST API:
 *   find:    GET    /api/cspm/v1/policy/policies/list   (list all, match by name)
 *   get:     GET    /api/cspm/v1/policy/posture/policies/<id>?include_controls=true
 *   apply:   POST   /api/cspm/v1/policy                 (upsert — id present = update)
 *   remove:  DELETE /api/cspm/v1/policy/policies/<id>    (for a disabled policy)
 *
 * The policy name is the stable identity used to upsert. `enabled: false` is
 * modeled as "absent", mirroring every other config type in this app.
 * rollbackData records, per policy, the action taken and the prior full body.
 */
type PolicyAction2 = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: PolicyAction2
  policyId: string | null
  prior: SysdigPosturePolicy | null
}

async function findLive(client: SysdigClient, name: string): Promise<SysdigPosturePolicySummary | null> {
  try {
    return findPolicySummaryByName(await client.listPosturePolicies(), name)
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const enabled = normalizeBoolean(item.fields.enabled, true)

      const summary = await findLive(client, name)
      const existingFull = summary ? await client.getPosturePolicyById(summary.id) : null

      if (!enabled) {
        if (summary) {
          await client.deletePosturePolicyById(summary.id)
          previous.push({ name, action: 'deleted', policyId: summary.id, prior: existingFull })
        } else {
          previous.push({ name, action: 'noop', policyId: null, prior: null })
        }
        applied.push(`${name} (removed)`)
        continue
      }

      const body = buildPolicyBody(item.fields, summary?.id)
      const saved = await client.createOrUpdatePosturePolicy(body)
      previous.push({ name, action: summary ? 'updated' : 'created', policyId: saved.id ?? summary?.id ?? null, prior: existingFull })
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} posture policy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Posture policy deploy failed after ${applied.length} policy(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
