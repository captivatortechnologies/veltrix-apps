import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAutomoxClient, automoxErrorMessage } from '../../lib/automoxApi'
import {
  listPolicies,
  getPolicyById,
  resolveCreatedPolicyId,
  extractCreatedPolicyId,
  findPolicyByName,
  priorFieldsOf,
  type AutomoxPolicy,
} from '../lib/automoxPolicies'
import { extractWorkletSpecs, buildWorkletBody } from './_shared'

/** One rollback record per applied worklet. */
export interface WorkletRollbackEntry {
  name: string
  /** Whether the policy already existed (update) or was created by this deploy. */
  existed: boolean
  id?: number
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/**
 * Deploy Automox Custom (Worklet) / Required Software policies over the
 * Console API (`/policies`), org-scoped via `o=<organizationId>`:
 *   list:   GET  /policies                (paged; match candidates by name + type)
 *   update: PUT  /policies/{id}           with the full managed policy body
 *   create: POST /policies                with the full managed policy body
 *
 * The name is the stable identity used to upsert, scoped to the item's OWN
 * `worklet_type` (custom | required_software) — see
 * ../lib/automoxPolicies.findPolicyByName — so this config type never adopts
 * a same-named PATCH policy owned by the `policies` config type, nor a
 * same-named policy of the OTHER worklet type. Matching is RENAME-SAFE via the
 * per-item resourceIds map (same pattern used by `policies`).
 *
 * VERIFIED (automox-mcp workflow, not documented in the OpenAPI spec):
 * `POST /policies` returns 201 with an EMPTY body — the new policy's id is
 * resolved by listing and matching the just-created name (highest id wins,
 * since the list is name-ordered, not recency-ordered).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildAutomoxClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractWorkletSpecs(ctx.canvas).filter((s) => s.name)
  const previousState: WorkletRollbackEntry[] = []
  const createdIds: number[] = []
  const applied: string[] = []
  const resourceIds: Record<string, number> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const livePolicies = await listPolicies(client)

    for (const spec of specs) {
      const builtBody = buildWorkletBody(spec, client.orgId)
      if (builtBody.error) throw new Error(`Worklet "${spec.name}" is invalid: ${builtBody.error}`)

      // Match order: (1) the id stored for this canvas item on the last deploy
      // (rename-safe), (2) by name+type for the first deploy / a stale stored id.
      let existing: AutomoxPolicy | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getPolicyById(client, priorId)
      if (!existing) existing = findPolicyByName(livePolicies, spec.name, spec.workletType)

      let policyId: number
      if (existing?.id) {
        policyId = existing.id
        const detailed = (await getPolicyById(client, policyId)) ?? existing
        previousState.push({ name: spec.name, existed: true, id: policyId, prior: priorFieldsOf(detailed) })
        const res = await client.request('PUT', `/policies/${policyId}`, { body: { ...builtBody.body, id: policyId } })
        if (!res.ok) throw new Error(`Failed to update Worklet "${spec.name}": ${automoxErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/policies', { body: builtBody.body })
        if (!res.ok) throw new Error(`Failed to create Worklet "${spec.name}": ${automoxErrorMessage(res)}`)
        const createdId = extractCreatedPolicyId(res.body) ?? (await resolveCreatedPolicyId(client, spec.name, spec.workletType))
        if (!createdId) {
          throw new Error(
            `Worklet "${spec.name}" was created but its id could not be resolved (POST /policies returns no body; ` +
              'the follow-up name lookup found no match — verify it in the Automox Console).',
          )
        }
        policyId = createdId
        createdIds.push(policyId)
        previousState.push({ name: spec.name, existed: false, id: policyId })
      }

      if (spec.itemId) resourceIds[spec.itemId] = policyId
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Worklet(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { organizationId: client.orgId, applied },
      rollbackData: { previousState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Worklet deploy failed after ${applied.length} of ${specs.length} worklet(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { organizationId: client.orgId, applied },
      rollbackData: { previousState, createdIds, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

/**
 * Read the canvas-item-id -> policy-id map this canvas stored on its last
 * SUCCEEDED deploy (rollbackData.resourceIds). Best-effort — {} on no prior
 * deploy or a read error.
 */
async function readPriorResourceIds(ctx: DeployContext): Promise<Record<string, number>> {
  try {
    const prior = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const rb = prior?.rollbackData as { resourceIds?: Record<string, number> } | undefined
    return rb?.resourceIds ?? {}
  } catch {
    return {}
  }
}
