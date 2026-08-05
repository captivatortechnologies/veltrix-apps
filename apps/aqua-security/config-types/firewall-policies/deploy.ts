import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAquaClient, type AquaFirewallPolicy } from '../../lib/aquasec'
import { buildFirewallPolicyBody, extractFirewallPolicySpecs } from './_shared'
import type { RollbackEntry } from '../lib/common'

/**
 * Deploy Aqua firewall policies over the Console REST API:
 *   find:    GET    /api/v2/firewall_policies/<name>
 *   create:  POST   /api/v2/firewall_policies
 *   update:  PUT    /api/v2/firewall_policies/<name>
 *   remove:  DELETE /api/v2/firewall_policies/<name>
 *
 * Every item in the canvas is deployed (this config type has no
 * enable/disable toggle — remove the item from the canvas to remove the
 * policy). The policy name is the stable identity used to upsert.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const specs = extractFirewallPolicySpecs(ctx.canvas)

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: RollbackEntry<AquaFirewallPolicy>[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      if (!spec.name) continue

      const existing = await client.getFirewallPolicy(spec.name)
      const body = buildFirewallPolicyBody(spec)

      if (existing) {
        await client.updateFirewallPolicy(body)
        previous.push({ name: spec.name, action: 'updated', prior: existing })
      } else {
        await client.createFirewallPolicy(body)
        previous.push({ name: spec.name, action: 'created', prior: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} firewall policy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Firewall policy deploy failed after ${applied.length} policy(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
