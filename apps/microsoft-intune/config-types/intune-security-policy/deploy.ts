import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson } from '../../lib/intune'
import {
  buildPolicyBody,
  getPolicyWithSettings,
  listConfigurationPolicies,
  parsePolicyJson,
  type ImportedPolicy,
} from '../../lib/policy'
import { extractPolicySpecs, policyKey } from './validate'

export interface PolicyRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: { name?: string; description?: string; templateReference?: unknown; settings?: unknown[] }
}

/**
 * Deploy imported endpoint-security policies via the Graph beta settings catalog.
 *
 * Reconciliation is by policy name (Graph does not enforce a unique name — the
 * name is our key): list the tenant's configuration policies, then PATCH an
 * existing policy by id or POST a new one. The canvas policy name/description are
 * authoritative; the pasted JSON supplies the templateReference + settings tree.
 * Non-destructive: policies not declared here are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: PolicyRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listConfigurationPolicies(client)
    const byName = new Map(existing.filter((p) => p.name).map((p) => [policyKey(p.name as string), p]))

    for (const spec of specs) {
      const parsed = parsePolicyJson(spec.policyJsonRaw)
      if (!parsed.value) throw new Error(`Policy "${spec.name}" has invalid JSON: ${parsed.error}`)
      const body = buildPolicyBody(spec.name, spec.description, parsed.value)
      const live = byName.get(policyKey(spec.name))

      if (live && live.id) {
        const prior = await getPolicyWithSettings(client, live.id)
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: prior?.name,
            description: prior?.description,
            templateReference: prior?.templateReference,
            settings: Array.isArray(prior?.settings) ? prior!.settings : [],
          },
        })
        const res = await client.request('PATCH', `/deviceManagement/configurationPolicies/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update policy "${spec.name}": ${graphErrorMessage(res)}`)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', '/deviceManagement/configurationPolicies', { body })
        if (!res.ok) throw new Error(`Failed to create policy "${spec.name}": ${graphErrorMessage(res)}`)
        const createdPolicy = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdPolicy?.id })
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `Endpoint-security policies deployed to ${graphHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Rebuild a deploy body from a captured prior policy (for rollback restore). */
export function priorToBody(prior: PolicyRollbackEntry['prior']): Record<string, unknown> {
  const imported: ImportedPolicy = {
    templateReference: prior?.templateReference as ImportedPolicy['templateReference'],
    settings: Array.isArray(prior?.settings) ? prior!.settings : [],
  }
  return buildPolicyBody(prior?.name ?? '', prior?.description ?? '', imported)
}
