import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage, parseJson } from '../../lib/secretServerApi'
import { extractDistributedEngineConfigSpec, buildDistributedEngineConfigPatchBody, type LiveDistributedEngineConfig } from './_shared'

/**
 * Deploy the Distributed Engine Configuration singleton over the REST API:
 *   read:   GET   /distributed-engine/configuration   (rollback snapshot)
 *   update: PATCH /distributed-engine/configuration   { data: { <field>: { dirty, value } } }
 *
 * There is no create/delete — this object always exists on a Secret Server
 * instance, so this handler always updates. Only fields the operator actually
 * set are ever sent (see _shared.ts) — a blank optional field leaves the live
 * value untouched, matching the module's own PATCH semantics.
 *
 * NOTE: verified against the Delinea/Thycotic PowerShell module source
 * (Get/Set-TssDistributedEngine); verify request/response shapes against a
 * live Secret Server 10.9.000064+.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiBase } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const item = items[0]
  if (!item) return { success: true, message: 'No Distributed Engine configuration declared.', rollbackData: {} }

  const spec = extractDistributedEngineConfigSpec(item.fields ?? {})

  try {
    const priorRes = await client.request('GET', '/distributed-engine/configuration')
    if (!priorRes.ok) throw new Error(`Failed to read the current Distributed Engine configuration: ${secretServerErrorMessage(priorRes)}`)
    const prior = parseJson<LiveDistributedEngineConfig>(priorRes.body) ?? {}

    const res = await client.request('PATCH', '/distributed-engine/configuration', { body: buildDistributedEngineConfigPatchBody(spec) })
    if (!res.ok) throw new Error(`Failed to update the Distributed Engine configuration: ${secretServerErrorMessage(res)}`)

    return {
      success: true,
      message: `Applied the Distributed Engine configuration to ${apiBase}.`,
      artifacts: { apiBase },
      rollbackData: { prior },
    }
  } catch (error) {
    return {
      success: false,
      message: `Distributed Engine configuration deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiBase },
    }
  }
}
