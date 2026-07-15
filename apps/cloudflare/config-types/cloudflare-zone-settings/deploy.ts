import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage, cloudflareResult } from '../../lib/cloudflare'
import { extractZoneSettingSpecs, settingKey, type LiveSetting } from './validate'

export interface ZoneSettingRollbackEntry {
  settingId: string
  label: string
  /** True when the setting's prior value was read successfully before the update. */
  existed: boolean
  /** The prior value, captured so rollback can PATCH it back. */
  priorValue?: unknown
}

/**
 * Deploy Cloudflare zone settings via the API (zone-scoped).
 *
 * Zone settings are per-zone singletons that always exist — this only reads and
 * updates, never creating or deleting. For each declared setting we GET the
 * current value (captured for rollback), then PATCH the new value. There is no
 * natural key to reconcile: the setting id IS the identity.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractZoneSettingSpecs(ctx.canvas).filter((s) => s.settingId && s.value)
  const rollbackState: ZoneSettingRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const id = settingKey(spec.settingId)
      const label = spec.settingId

      // Capture the prior value so rollback can restore it (PATCH back). If the
      // read fails (unknown id or plan-gated setting), record existed:false so
      // rollback skips it and let the PATCH below surface the real error.
      const current = await client.zone('GET', `/settings/${id}`)
      if (current.ok) {
        const prior = cloudflareResult<LiveSetting>(current)
        rollbackState.push({ settingId: id, label, existed: true, priorValue: prior?.value })
      } else {
        rollbackState.push({ settingId: id, label, existed: false })
      }

      const res = await client.zone('PATCH', `/settings/${id}`, { body: { value: spec.value } })
      if (!res.ok) throw new Error(`Failed to update setting "${label}": ${cloudflareErrorMessage(res)}`)
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} zone setting(s) to zone "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedSettings: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Zone settings deployment failed after ${deployed.length} of ${specs.length} setting(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedSettings: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}
