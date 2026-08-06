import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { assignPolicy } from '../../lib/gravityZoneApi'
import { extractPolicyAssignmentSpecs } from './_shared'

export interface PolicyAssignmentRollbackEntry {
  assignmentName: string
  targetIds: string[]
}

/**
 * Deploy GravityZone policy assignments: network.assignPolicy is a
 * fire-and-forget convergence action (not a persisted object with its own
 * GET), so this app re-applies it on every deploy rather than diffing
 * against a prior read. See README.md "Known limitations" for why rollback
 * cannot restore each target's specific PRIOR policy.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractPolicyAssignmentSpecs(ctx.canvas).filter((s) => s.assignmentName && s.targetIds.length > 0)
  const previous: PolicyAssignmentRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      await assignPolicy(client, {
        targetIds: spec.targetIds,
        policyId: spec.inheritFromAbove ? undefined : spec.policyId,
        inheritFromAbove: spec.inheritFromAbove,
        forcePolicyInheritance: spec.forcePolicyInheritance,
      })
      previous.push({ assignmentName: spec.assignmentName, targetIds: spec.targetIds })
      deployed.push(spec.assignmentName)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} policy assignment(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy assignment deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
