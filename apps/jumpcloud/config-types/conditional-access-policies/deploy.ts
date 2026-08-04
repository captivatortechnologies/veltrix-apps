import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, parseJson, type JumpCloudClient } from '../../lib/jumpcloudApi'
import {
  extractConditionalAccessPolicySpecs,
  parseJsonObjectField,
  buildAuthnPolicyBody,
  findAuthnPolicyByName,
  priorFieldsOf,
  type JumpCloudAuthnPolicy,
} from './_shared'

/** One rollback record per applied Authentication Policy. */
export interface ConditionalAccessPolicyRollbackEntry {
  name: string
  /** Whether the policy already existed (update) or was created by this deploy. */
  existed: boolean
  id?: string
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/**
 * Deploy JumpCloud Authentication (Conditional Access) Policies over the API v2
 * (/authn/policies):
 *   list:   GET   /authn/policies                     (paged; match candidates by name)
 *   update: PATCH /authn/policies/{id}  with the AuthnPolicy body (excl. `type`)
 *   create: POST  /authn/policies       with the AuthnPolicy body (incl. `type`)
 *
 * The name is the stable identity used to upsert. Matching is RENAME-SAFE via the
 * per-item resourceIds map (same pattern as the other JumpCloud config types).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractConditionalAccessPolicySpecs(ctx.canvas).filter((s) => s.name)
  const previousState: ConditionalAccessPolicyRollbackEntry[] = []
  const createdIds: string[] = []
  const applied: string[] = []
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const livePolicies = await listAuthnPolicies(client)

    for (const spec of specs) {
      const parsedTargets = parseJsonObjectField(spec.targetsRaw, 'targets')
      if (parsedTargets.error) throw new Error(`Policy "${spec.name}": ${parsedTargets.error}`)
      const parsedConditions = parseJsonObjectField(spec.conditionsRaw, 'conditions')
      if (parsedConditions.error) throw new Error(`Policy "${spec.name}": ${parsedConditions.error}`)

      let existing: JumpCloudAuthnPolicy | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getAuthnPolicyById(client, priorId)
      if (!existing) existing = findAuthnPolicyByName(livePolicies, spec.name)

      let policyId: string
      if (existing?.id) {
        policyId = existing.id
        const detailed = (await getAuthnPolicyById(client, policyId)) ?? existing
        previousState.push({ name: spec.name, existed: true, id: policyId, prior: priorFieldsOf(detailed) })
        const body = buildAuthnPolicyBody(spec, parsedTargets.value, parsedConditions.value, { includeType: false })
        const res = await client.request('PATCH', `/authn/policies/${encodeURIComponent(policyId)}`, { body })
        if (!res.ok) throw new Error(`Failed to update Authentication Policy "${spec.name}": ${jumpCloudErrorMessage(res)}`)
      } else {
        const body = buildAuthnPolicyBody(spec, parsedTargets.value, parsedConditions.value, { includeType: true })
        const res = await client.request('POST', '/authn/policies', { body })
        if (!res.ok) throw new Error(`Failed to create Authentication Policy "${spec.name}": ${jumpCloudErrorMessage(res)}`)
        const created = parseJson<JumpCloudAuthnPolicy>(res.body)
        if (!created?.id) throw new Error(`Authentication Policy "${spec.name}" was created but the API returned no id`)
        policyId = created.id
        createdIds.push(policyId)
        previousState.push({ name: spec.name, existed: false, id: policyId })
      }

      if (spec.itemId) resourceIds[spec.itemId] = policyId
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Authentication Policy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Authentication Policy deploy failed after ${applied.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every Authentication Policy in the org, following pagination. */
export async function listAuthnPolicies(client: JumpCloudClient): Promise<JumpCloudAuthnPolicy[]> {
  const res = await client.listAll<JumpCloudAuthnPolicy>('/authn/policies')
  if (!res.ok) {
    throw new Error(`Failed to list Authentication Policies: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch an Authentication Policy by id, or null on 404 / any non-ok. */
export async function getAuthnPolicyById(client: JumpCloudClient, id: string): Promise<JumpCloudAuthnPolicy | null> {
  const res = await client.request('GET', `/authn/policies/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const policy = parseJson<JumpCloudAuthnPolicy>(res.body)
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
