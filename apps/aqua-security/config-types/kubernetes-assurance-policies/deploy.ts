import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAquaClient, type AquaAssurancePolicy } from '../../lib/aquasec'
import { buildAssurancePolicyBody, extractAssurancePolicySpecs } from '../lib/assurancePolicy'
import type { RollbackEntry } from '../lib/common'

const ASSURANCE_TYPE = 'kubernetes' as const

/**
 * Deploy Aqua kubernetes assurance policies over the Console REST API:
 *   find:    GET    /api/v2/assurance_policy/kubernetes/<name>
 *   create:  POST   /api/v2/assurance_policy/kubernetes
 *   update:  PUT    /api/v2/assurance_policy/kubernetes/<name>
 *   remove:  DELETE /api/v2/assurance_policy/kubernetes/<name>  (for a disabled policy)
 *
 * The policy name is the stable identity used to upsert. `enabled: false` is
 * modeled as "absent" — a disabled policy that exists is deleted.
 * rollbackData records, per policy, the action taken and the prior policy
 * body so rollback can restore/remove precisely.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const specs = extractAssurancePolicySpecs(ctx.canvas)

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: RollbackEntry<AquaAssurancePolicy>[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      if (!spec.name) continue

      const existing = await client.getAssurancePolicy(ASSURANCE_TYPE, spec.name)

      if (!spec.enabled) {
        if (existing) {
          await client.deleteAssurancePolicy(ASSURANCE_TYPE, spec.name)
          previous.push({ name: spec.name, action: 'deleted', prior: existing })
        } else {
          previous.push({ name: spec.name, action: 'noop', prior: null })
        }
        applied.push(`${spec.name} (removed)`)
        continue
      }

      const body = buildAssurancePolicyBody(spec, ASSURANCE_TYPE)
      if (existing) {
        await client.updateAssurancePolicy(ASSURANCE_TYPE, body)
        previous.push({ name: spec.name, action: 'updated', prior: existing })
      } else {
        await client.createAssurancePolicy(ASSURANCE_TYPE, body)
        previous.push({ name: spec.name, action: 'created', prior: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} kubernetes assurance policy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Image assurance policy deploy failed after ${applied.length} policy(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
