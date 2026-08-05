import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAquaClient, type AquaEnforcerGroup } from '../../lib/aquasec'
import { buildEnforcerGroupBody, extractEnforcerGroupSpecs } from './_shared'
import type { RollbackEntry } from '../lib/common'

/**
 * Deploy Aqua Enforcer Group protection configuration over the Console REST
 * API:
 *   find:    GET    /api/v1/hostsbatch/<groupId>
 *   create:  POST   /api/v1/hostsbatch
 *   update:  PUT    /api/v1/hostsbatch    (the group's `id` in the body IS
 *                                          the identity — no path parameter)
 *
 * The Group ID is the stable identity used to upsert. Removing the item from
 * the canvas removes the group (DELETE /api/v1/hostsbatch/<groupId> —
 * ?delete_related=true, matching the official client's own DeleteEnforcerGroup).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const specs = extractEnforcerGroupSpecs(ctx.canvas)

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: RollbackEntry<AquaEnforcerGroup>[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      if (!spec.groupId) continue

      const existing = await client.getEnforcerGroup(spec.groupId)
      const body = buildEnforcerGroupBody(spec)

      if (existing) {
        await client.updateEnforcerGroup(body)
        previous.push({ name: spec.groupId, action: 'updated', prior: existing })
      } else {
        await client.createEnforcerGroup(body)
        previous.push({ name: spec.groupId, action: 'created', prior: null })
      }
      applied.push(spec.groupId)
    }

    return {
      success: true,
      message: `Applied ${applied.length} enforcer group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Enforcer group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
