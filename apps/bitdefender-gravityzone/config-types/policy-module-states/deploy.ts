import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getPolicyDetails, setPolicyModulesState } from '../../lib/gravityZoneApi'
import { extractPolicyModuleStateSpecs, parseSettings } from './_shared'

export interface PolicyModuleStateRollbackEntry {
  policyId: string
  /** Best-effort snapshot of policies.getPolicyDetails BEFORE this deploy — see README.md "Known limitations" for why it cannot be replayed automatically. */
  priorDetails: Record<string, unknown> | null
}

/**
 * Deploy GravityZone policy module states: policies.setPolicyModulesState
 * against an EXISTING policy (this app never creates/deletes a policy — see
 * canvas.yaml). Captures a best-effort snapshot of the policy's full details
 * via getPolicyDetails before applying, purely for operator reference on
 * rollback (see rollback.ts for why it cannot be replayed automatically).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractPolicyModuleStateSpecs(ctx.canvas).filter((s) => s.policyId && s.settingsRaw)
  const previous: PolicyModuleStateRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { value: settings, error } = parseSettings(spec)
      if (error || !settings) throw new Error(error ?? `Policy "${spec.policyId}" settings is not valid JSON`)

      const priorDetails = await getPolicyDetails(client, spec.policyId)
      await setPolicyModulesState(client, spec.policyId, settings)
      previous.push({ policyId: spec.policyId, priorDetails })
      deployed.push(spec.policyId)
    }

    return {
      success: true,
      message: `Applied module states for ${deployed.length} policy(ies): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy module state deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
