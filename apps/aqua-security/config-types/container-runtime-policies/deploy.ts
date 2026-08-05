import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAquaClient, type AquaRuntimePolicy } from '../../lib/aquasec'
import { buildRuntimePolicyBody, extractRuntimePolicySpecs } from '../lib/runtimePolicy'
import type { RollbackEntry } from '../lib/common'

const RUNTIME_TYPE = 'container' as const

/**
 * Deploy Aqua container runtime policies over the Console REST API:
 *   find:    GET    /api/v2/runtime_policies/<name>
 *   create:  POST   /api/v2/runtime_policies
 *   update:  PUT    /api/v2/runtime_policies/<name>
 *   remove:  DELETE /api/v2/runtime_policies/<name>  (for a disabled policy)
 *
 * The policy name is the stable identity used to upsert. `enabled: false` is
 * modeled as "absent" — a disabled policy that exists is deleted.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const specs = extractRuntimePolicySpecs(ctx.canvas)

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: RollbackEntry<AquaRuntimePolicy>[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      if (!spec.name) continue

      const existing = await client.getRuntimePolicy(spec.name)

      if (!spec.enabled) {
        if (existing) {
          await client.deleteRuntimePolicy(spec.name)
          previous.push({ name: spec.name, action: 'deleted', prior: existing })
        } else {
          previous.push({ name: spec.name, action: 'noop', prior: null })
        }
        applied.push(`${spec.name} (removed)`)
        continue
      }

      const body = buildRuntimePolicyBody(spec, RUNTIME_TYPE)
      if (existing) {
        await client.updateRuntimePolicy(body)
        previous.push({ name: spec.name, action: 'updated', prior: existing })
      } else {
        await client.createRuntimePolicy(body)
        previous.push({ name: spec.name, action: 'created', prior: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} container runtime policy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Container runtime policy deploy failed after ${applied.length} policy(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
