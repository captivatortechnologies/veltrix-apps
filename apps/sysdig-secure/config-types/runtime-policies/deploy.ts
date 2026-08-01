import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigClient, type SysdigPolicy } from '../../lib/sysdigApi'
import { buildPolicyBody, findPolicyByName, normalizeEnabled } from './_shared'

/**
 * Deploy Sysdig Secure runtime policies over the REST API:
 *   find:    GET    /api/v2/policies          (list all, match by name)
 *   create:  POST   /api/v2/policies
 *   update:  PUT    /api/v2/policies/<id>      (carries the live id + version)
 *   remove:  DELETE /api/v2/policies/<id>      (for a disabled policy)
 *
 * The policy name is the stable identity used to upsert. `enabled: false` is
 * modeled as "absent" — a disabled policy that exists is deleted (mirroring the
 * Falco-rules config type). rollbackData records, per policy, the action taken
 * and the prior policy body so rollback can restore/remove precisely.
 */
type PolicyAction2 = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: PolicyAction2
  policyId: number | null
  /** The policy body BEFORE this deploy (null when it did not exist). */
  prior: SysdigPolicy | null
}

/** Look up a policy by name (best-effort — a lookup error is treated as "not found"). */
async function findLive(client: SysdigClient, name: string): Promise<SysdigPolicy | null> {
  try {
    return findPolicyByName(await client.listPolicies(), name)
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
      const enabled = normalizeEnabled(item.fields.enabled)

      const existing = await findLive(client, name)
      const existingId = typeof existing?.id === 'number' ? existing.id : null

      if (!enabled) {
        if (existing && existingId != null) {
          await client.deletePolicy(existingId)
          previous.push({ name, action: 'deleted', policyId: existingId, prior: existing })
        } else {
          previous.push({ name, action: 'noop', policyId: null, prior: null })
        }
        applied.push(`${name} (removed)`)
        continue
      }

      const body = buildPolicyBody(item.fields)
      if (existing && existingId != null) {
        await client.updatePolicy(existingId, { ...body, id: existingId, version: existing.version })
        previous.push({ name, action: 'updated', policyId: existingId, prior: existing })
      } else {
        const created = await client.createPolicy(body)
        const newId = typeof created?.id === 'number' ? created.id : null
        previous.push({ name, action: 'created', policyId: newId, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} runtime policy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Runtime policy deploy failed after ${applied.length} policy(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
