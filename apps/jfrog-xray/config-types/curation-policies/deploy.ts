import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, parseJson, xrayErrorMessage, type XrayClient } from '../../lib/xrayApi'
import { buildEditablePolicy, extractCurationPolicySpecs, findPolicy, type XrayCurationPolicy } from './_shared'

export const CURATION_POLICIES_PATH = '/api/v1/curation/policies'
export const curationPolicyPath = (policyId: string): string => `${CURATION_POLICIES_PATH}/${encodeURIComponent(policyId)}`
// The list endpoint paginates; 500 covers realistic curation-policy counts in one
// page. A tenant with more would need a follow-up page — flagged in README Coverage.
const LIST_QUERY = `${CURATION_POLICIES_PATH}?num_of_rows=500`

export interface CurationRollbackEntry {
  name: string
  /** The server-assigned policy id — the actual write-URL key (see module header). */
  policyId: string
  existed: boolean
  prior?: XrayCurationPolicy
}

interface CurationListResponse {
  data?: XrayCurationPolicy[]
}

/**
 * Deploy JFrog Curation policies over the Xray REST API:
 *   list (identity):  GET    /api/v1/curation/policies                → match by name
 *   read (rollback):  GET    /api/v1/curation/policies/{policy_id}     → full prior body
 *   create:            POST   /api/v1/curation/policies                 with the editable-fields body
 *   update:            PUT    /api/v1/curation/policies/{policy_id}     PARTIAL update — Xray
 *                                                                        explicitly rejects read-only
 *                                                                        fields (id, created_by,
 *                                                                        updated_by, created_at,
 *                                                                        updated_at) being sent back
 * Upserts by NAME (via the list), but the write URLs key off the SERVER-ASSIGNED `policy_id` — so
 * rollbackData tracks both. If a create response doesn't echo the new id directly, this falls back
 * to re-listing and matching by name to recover it.
 *
 * Docs:
 *   https://docs.jfrog.com/security/reference/createpolicy (POST /xray/api/v1/curation/policies)
 *   https://docs.jfrog.com/security/reference/listpolicies (GET, paginated {data,meta})
 *   https://docs.jfrog.com/security/reference/getpolicybyid (GET .../{policy_id})
 *   https://docs.jfrog.com/security/reference/updatepolicy (PUT .../{policy_id}, partial update)
 *   https://docs.jfrog.com/security/reference/deletepolicy (DELETE .../{policy_id})
 * Cross-checked against JFrog's own Terraform provider for the waiver/label-waiver shapes:
 *   https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/curation_policy.md
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built

  const specs = extractCurationPolicySpecs(ctx.canvas).filter((s) => s.name && s.conditionId)
  const rollbackState: CurationRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const list = await listCurationPolicies(client)

    for (const spec of specs) {
      const desired = buildEditablePolicy(spec)
      const existing = findPolicy(list, spec.name)

      if (existing) {
        const detailRes = await client.request('GET', curationPolicyPath(existing.id))
        if (!detailRes.ok) throw new Error(`Failed to read curation policy "${spec.name}": HTTP ${detailRes.status}: ${xrayErrorMessage(detailRes)}`)
        const prior = parseJson<XrayCurationPolicy>(detailRes.body) ?? existing
        rollbackState.push({ name: spec.name, policyId: existing.id, existed: true, prior })

        const putRes = await client.request('PUT', curationPolicyPath(existing.id), desired)
        if (!putRes.ok) throw new Error(`Failed to update curation policy "${spec.name}": HTTP ${putRes.status}: ${xrayErrorMessage(putRes)}`)
      } else {
        const postRes = await client.request('POST', CURATION_POLICIES_PATH, desired)
        if (!postRes.ok) throw new Error(`Failed to create curation policy "${spec.name}": HTTP ${postRes.status}: ${xrayErrorMessage(postRes)}`)

        const created = parseJson<{ id?: string }>(postRes.body)
        const newId = created?.id ?? (await recoverPolicyId(client, spec.name))
        if (!newId) throw new Error(`Curation policy "${spec.name}" was created but its id could not be recovered`)
        rollbackState.push({ name: spec.name, policyId: newId, existed: false })
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} curation polic${deployed.length === 1 ? 'y' : 'ies'} to ${host}: ${deployed.join(', ')}`,
      artifacts: { host, deployedPolicies: deployed },
      rollbackData: { previous: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Curation-policy deployment failed after ${deployed.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { host, deployedPolicies: deployed },
      rollbackData: { previous: rollbackState },
    }
  }
}

/** List every curation policy (one page — see LIST_QUERY note). Throws on a transport/HTTP error. */
export async function listCurationPolicies(client: XrayClient): Promise<XrayCurationPolicy[]> {
  const res = await client.request('GET', LIST_QUERY)
  if (!res.ok) throw new Error(`Failed to list curation policies: HTTP ${res.status}: ${xrayErrorMessage(res)}`)
  return parseJson<CurationListResponse>(res.body)?.data ?? []
}

/** Defensive fallback when a create response doesn't echo the new policy's id directly. */
async function recoverPolicyId(client: XrayClient, name: string): Promise<string | undefined> {
  try {
    const list = await listCurationPolicies(client)
    return findPolicy(list, name)?.id
  } catch {
    return undefined
  }
}
