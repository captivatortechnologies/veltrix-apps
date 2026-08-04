import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson, type AkamaiClient } from '../../lib/akamaiApi'
import {
  contentFromResponse,
  effectiveVersion,
  findPolicy,
  isPending,
  policiesPath,
  policyActivationsPath,
  readActivationFields,
  type CloudletPolicy,
} from './_shared'

/**
 * Deploy = TRIGGER a Cloudlets policy activation over the Cloudlets API v3
 * (EdgeGrid-signed):
 *   resolve policy by name: GET  /cloudlets/v3/policies
 *   activate:                POST /cloudlets/v3/policies/{id}/activations   { operation: "ACTIVATION", network, policyVersion }
 *
 * This is an ACTION, not a desired-state object, so deploy is modelled
 * idempotently: a policy already effective at the declared version on the
 * target network is SKIPPED, and a policy with an activation already in
 * flight (latest request status IN_PROGRESS) is left alone rather than
 * re-triggered. `rollbackData.previous` records the prior effective version
 * per target (null when never activated there) AND the version this deploy
 * activated — rollback.ts uses the real deactivation operation this API
 * exposes to genuinely undo it (see rollback.ts).
 */

interface PriorEntry {
  policyName: string
  policyId: number
  network: string
  priorEffectiveVersion: number | null
  activatedVersion: number | null
  /** 'activated' | 'skipped-active' | 'skipped-pending' */
  outcome: string
}

async function listAllPolicies(client: AkamaiClient): Promise<CloudletPolicy[]> {
  const res = await client.request('GET', policiesPath, { query: { size: 1000 } })
  if (!res.ok) throw new Error(`GET ${policiesPath} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return contentFromResponse<CloudletPolicy>(parseJson<unknown>(res.body))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PriorEntry[] = []
  const activated: string[] = []
  const skippedActive: string[] = []
  const skippedPending: string[] = []

  try {
    const live = await listAllPolicies(client)

    for (const item of items) {
      const fields = readActivationFields(item.fields)
      if (!fields.policyName) continue

      const policy = findPolicy(live, fields.policyName)
      if (!policy?.id) {
        throw new Error(`Cloudlets policy "${fields.policyName}" was not found — create it (Cloudlets Policies config type) before activating it.`)
      }
      const policyId = policy.id
      const label = `${fields.policyName} → ${fields.network}`
      const priorEffectiveVersion = effectiveVersion(policy, fields.network)

      if (priorEffectiveVersion === fields.policyVersion) {
        skippedActive.push(label)
        previous.push({ policyName: fields.policyName, policyId, network: fields.network, priorEffectiveVersion, activatedVersion: null, outcome: 'skipped-active' })
        continue
      }

      if (isPending(policy, fields.network)) {
        skippedPending.push(label)
        previous.push({ policyName: fields.policyName, policyId, network: fields.network, priorEffectiveVersion, activatedVersion: null, outcome: 'skipped-pending' })
        continue
      }

      const res = await client.request('POST', policyActivationsPath(policyId), {
        body: { operation: 'ACTIVATION', network: fields.network, policyVersion: fields.policyVersion },
      })
      if (!res.ok) throw new Error(`activate "${label}" (v${fields.policyVersion}) → HTTP ${res.status}: ${res.body.slice(0, 300)}`)

      activated.push(label)
      previous.push({ policyName: fields.policyName, policyId, network: fields.network, priorEffectiveVersion, activatedVersion: fields.policyVersion, outcome: 'activated' })
    }

    const parts = [`${activated.length} activation(s) triggered${activated.length ? `: ${activated.join(', ')}` : ''}`]
    if (skippedActive.length) parts.push(`${skippedActive.length} already active`)
    if (skippedPending.length) parts.push(`${skippedPending.length} in-flight (left alone)`)

    return {
      success: true,
      message: parts.join('; '),
      artifacts: { activated, skippedActive, skippedPending },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Cloudlets policy activation failed after ${activated.length} trigger(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { activated, skippedActive, skippedPending },
      rollbackData: { previous },
    }
  }
}
