import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigPolicy } from '../../lib/sysdigApi'
import { applyTuning, findManagedPolicy, normalizeBoolean, resetTuning } from './_shared'

/**
 * Deploy Managed Policy tuning over the REST API:
 *   find:   GET /api/v2/policies                (list all, match by name+type+isDefault)
 *   apply:  PUT /api/v2/policies/<id>            (carries the live id + version)
 *
 * A managed policy is Sysdig-owned content — this app can only tune an
 * EXISTING one, never create or delete it. An item whose name+type does not
 * match a live managed policy fails the deploy outright (there is nothing to
 * apply it to, unlike an optional cross-reference elsewhere in this app).
 * `enabled: false` resets the policy to Sysdig defaults (the same reset
 * Terraform performs when a managed-policy resource is destroyed).
 * rollbackData records, per policy, the prior full body so rollback can
 * restore it verbatim.
 */
interface RollbackEntry {
  name: string
  type: string
  policyId: number
  prior: SysdigPolicy
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    const policies = await client.listPolicies()

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const type = String(item.fields.type ?? 'falco').trim()
      const enabled = normalizeBoolean(item.fields.enabled, true)

      const existing = findManagedPolicy(policies, name, type)
      if (!existing || typeof existing.id !== 'number') {
        return {
          success: false,
          message: `Applied ${applied.length} managed policy(ies) before failing: no managed policy named "${name}" of type "${type}" was found. Managed policies cannot be created — check the name and type against the Sysdig console.`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const body = enabled ? applyTuning(existing, item.fields) : resetTuning(existing)
      await client.updatePolicy(existing.id, { ...body, id: existing.id, version: existing.version })
      previous.push({ name, type, policyId: existing.id, prior: existing })
      applied.push(enabled ? name : `${name} (reset to default)`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} managed policy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Managed policy deploy failed after ${applied.length} policy(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
