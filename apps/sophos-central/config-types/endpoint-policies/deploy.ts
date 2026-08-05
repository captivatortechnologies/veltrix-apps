import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { createPolicy, listPolicies, updatePolicy, type SophosPolicy } from '../../lib/sophosApi'
import { buildPolicyCreateBody, buildPolicyPatchBody, extractPolicySpecs, parsePolicySpec, policyKey, policyMatches } from './_shared'

export interface PolicyRollbackEntry {
  key: string
  existed: boolean
  id?: string
  prior?: Pick<SophosPolicy, 'name' | 'enabled' | 'priority' | 'disableAt' | 'appliesTo' | 'settings'>
}

/**
 * Deploy Sophos Central endpoint policies, reconciled by (name, type):
 *   list:   GET   /policies                        -> find by (name, type)
 *   update: PATCH /policies/{id}                     when found and different (`type` is immutable)
 *   create: POST  /policies                          when not found
 *
 * The live list is read once (across every declared policyType) and reused
 * across every item.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name && s.type)
  const previous: PolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const live = await listPolicies(client)
    const liveByKey = new Map(live.filter((p) => p.name && p.type).map((p) => [policyKey(p.name, p.type), p] as const))

    for (const spec of specs) {
      const { value: parsed, error } = parsePolicySpec(spec)
      if (error || !parsed) throw new Error(`Policy "${spec.name}" (type "${spec.type}"): ${error ?? 'invalid policy'}`)

      const key = policyKey(spec.name, spec.type)
      const match = liveByKey.get(key)
      const label = `${spec.name} (${spec.type})`

      if (!match) {
        const created = await createPolicy(client, buildPolicyCreateBody(parsed))
        previous.push({ key, existed: false, id: created.id })
      } else if (policyMatches(parsed, match)) {
        previous.push({ key, existed: true, id: match.id, prior: match })
      } else {
        if (match.id) await updatePolicy(client, match.id, buildPolicyPatchBody(parsed))
        previous.push({ key, existed: true, id: match.id, prior: match })
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} endpoint polic${deployed.length === 1 ? 'y' : 'ies'}: ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Endpoint policy deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
