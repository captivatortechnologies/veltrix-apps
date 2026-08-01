import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, parseJson, type JumpCloudClient } from '../../lib/jumpcloudApi'
import {
  extractPolicySpecs,
  parsePolicyValues,
  buildPolicyBody,
  findPolicyByName,
  priorFieldsOf,
  type JumpCloudPolicy,
} from './_shared'

/** One rollback record per applied policy. */
export interface PolicyRollbackEntry {
  name: string
  /** Whether the policy already existed (update) or was created by this deploy. */
  existed: boolean
  id?: string
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/**
 * Deploy JumpCloud Policies over the API v2 (/policies):
 *   list:   GET  /policies                     (paged; match candidates by name)
 *   update: PUT  /policies/{id}  with PolicyRequest { name, template:{id}, values, active }
 *   create: POST /policies       with PolicyRequest { name, template:{id}, values, active }
 *
 * The name is the stable identity used to upsert. Matching is RENAME-SAFE via the
 * per-item resourceIds map (same pattern as the other JumpCloud config types).
 *
 * FLAGGED (verify against a live JumpCloud tenant): the PolicyValue wire shape
 * beyond `configFieldID`, and whether the write API accepts `active`. Creating a
 * policy also requires a valid Template Id and template-specific config-field
 * ids — those come from the operator's tenant (GET /api/v2/policytemplates).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
  const previousState: PolicyRollbackEntry[] = []
  const createdIds: string[] = []
  const applied: string[] = []
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const livePolicies = await listPolicies(client)

    for (const spec of specs) {
      const parsed = parsePolicyValues(spec.valuesRaw)
      if (parsed.error) throw new Error(`Policy "${spec.name}" has invalid values: ${parsed.error}`)
      const body = buildPolicyBody(spec, parsed.values)

      // Match order: (1) the id stored for this canvas item on the last deploy
      // (rename-safe), (2) by name for the first deploy / a stale stored id.
      let existing: JumpCloudPolicy | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getPolicyById(client, priorId)
      if (!existing) existing = findPolicyByName(livePolicies, spec.name)

      let policyId: string
      if (existing?.id) {
        policyId = existing.id
        const detailed = (await getPolicyById(client, policyId)) ?? existing
        previousState.push({ name: spec.name, existed: true, id: policyId, prior: priorFieldsOf(detailed) })
        const res = await client.request('PUT', `/policies/${encodeURIComponent(policyId)}`, { body })
        if (!res.ok) throw new Error(`Failed to update Policy "${spec.name}": ${jumpCloudErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/policies', { body })
        if (!res.ok) throw new Error(`Failed to create Policy "${spec.name}": ${jumpCloudErrorMessage(res)}`)
        const created = parseJson<JumpCloudPolicy>(res.body)
        if (!created?.id) throw new Error(`Policy "${spec.name}" was created but the API returned no id`)
        policyId = created.id
        createdIds.push(policyId)
        previousState.push({ name: spec.name, existed: false, id: policyId })
      }

      if (spec.itemId) resourceIds[spec.itemId] = policyId
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Policy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy deploy failed after ${applied.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every Policy in the org, following pagination. */
export async function listPolicies(client: JumpCloudClient): Promise<JumpCloudPolicy[]> {
  const res = await client.listAll<JumpCloudPolicy>('/policies')
  if (!res.ok) {
    throw new Error(`Failed to list Policies: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch a policy (with details) by id, or null on 404 / any non-ok. */
export async function getPolicyById(client: JumpCloudClient, id: string): Promise<JumpCloudPolicy | null> {
  const res = await client.request('GET', `/policies/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const policy = parseJson<JumpCloudPolicy>(res.body)
  return policy?.id ? policy : null
}

/**
 * Read the canvas-item-id -> policy-id map this canvas stored on its last
 * SUCCEEDED deploy (rollbackData.resourceIds). Best-effort — {} on no prior
 * deploy or a read error.
 */
async function readPriorResourceIds(ctx: DeployContext): Promise<Record<string, string>> {
  try {
    const prior = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const rb = prior?.rollbackData as { resourceIds?: Record<string, string> } | undefined
    return rb?.resourceIds ?? {}
  } catch {
    return {}
  }
}
