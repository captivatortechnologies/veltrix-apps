import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage, parseJson } from '../../lib/secretServerApi'
import {
  extractPolicySpecs,
  searchPolicies,
  findPolicyByName,
  buildPolicyCreateBody,
  buildPolicyUpdateBody,
  policyIdOf,
  type LivePolicy,
} from './_shared'

/**
 * One policy's prior state, captured for rollback. `existed` distinguishes an
 * UPDATE (restore `prior`) from a CREATE (leave the new policy in place).
 */
export interface PolicyRollbackEntry {
  secretPolicyName: string
  policyId: number | null
  existed: boolean
  prior: LivePolicy | null
}

/**
 * Deploy Secret Server secret policies over the REST API (/api/v1/secret-policy):
 *   read:   GET   /secret-policy/search?filter.secretPolicyName=<name>  → match by name
 *   create: POST  /secret-policy                                        with { data: {...} }
 *   update: PATCH /secret-policy/{id}                                   with { data: { <field>: { dirty, value } } }
 *
 * Identity is secretPolicyName. rollbackData records, per policy, the prior body
 * (null when it did not exist) AND its id — so rollback can restore the prior
 * body, or leave a newly created policy in place (policy deletion is not managed
 * by this app).
 *
 * NOTE: paths/fields verified against the Delinea/Thycotic PowerShell module
 * source; verify request/response shapes against a live Secret Server 11.0+.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiBase } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const specs = extractPolicySpecs(items).filter((s) => s.secretPolicyName)

  const previous: PolicyRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      const matches = await searchPolicies(client, spec.secretPolicyName)
      const existing = findPolicyByName(matches, spec.secretPolicyName)

      if (existing) {
        const policyId = policyIdOf(existing)
        if (policyId === null) throw new Error(`Secret policy "${spec.secretPolicyName}" exists but has no usable id`)
        const res = await client.request('PATCH', `/secret-policy/${policyId}`, { body: buildPolicyUpdateBody(spec) })
        if (!res.ok) throw new Error(`Failed to update secret policy "${spec.secretPolicyName}": ${secretServerErrorMessage(res)}`)
        previous.push({ secretPolicyName: spec.secretPolicyName, policyId, existed: true, prior: existing })
      } else {
        const res = await client.request('POST', '/secret-policy', { body: buildPolicyCreateBody(spec) })
        if (!res.ok) throw new Error(`Failed to create secret policy "${spec.secretPolicyName}": ${secretServerErrorMessage(res)}`)
        const created = parseJson<LivePolicy>(res.body)
        previous.push({
          secretPolicyName: spec.secretPolicyName,
          policyId: created ? policyIdOf(created) : null,
          existed: false,
          prior: null,
        })
      }
      applied.push(spec.secretPolicyName)
    }

    return {
      success: true,
      message: `Applied ${applied.length} secret policy(ies) to ${apiBase}: ${applied.join(', ') || '(none)'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Secret policy deploy failed after ${applied.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  }
}
