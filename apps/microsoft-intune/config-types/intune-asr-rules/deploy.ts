import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import { buildAsrPolicyBody, isAsrPolicy, type LivePolicy } from '../../lib/asr'
import { extractAsrSpecs, policyKey } from './validate'

export interface AsrRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: { name?: string; description?: string; settings?: unknown }
}

/**
 * Deploy Defender ASR rule policies via the Graph beta settings catalog.
 *
 * Reconciliation is by policy name (Graph does not enforce a unique name, so the
 * name is our key): list the tenant's ASR policies, then PATCH an existing policy
 * by id or POST a new one. Existing policies are updated in place (id + any
 * assignments preserved). Non-destructive: policies not declared here are left
 * untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractAsrSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: AsrRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listAsrPolicies(client)
    const byName = new Map(existing.filter((p) => p.name).map((p) => [policyKey(p.name as string), p]))

    for (const spec of specs) {
      const body = buildAsrPolicyBody(spec)
      const live = byName.get(policyKey(spec.name))

      if (live && live.id) {
        const prior = await getPolicyWithSettings(client, live.id)
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: { name: prior?.name, description: prior?.description, settings: prior?.settings ?? [] },
        })
        const res = await client.request('PATCH', `/deviceManagement/configurationPolicies/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update ASR policy "${spec.name}": ${graphErrorMessage(res)}`)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', '/deviceManagement/configurationPolicies', { body })
        if (!res.ok) throw new Error(`Failed to create ASR policy "${spec.name}": ${graphErrorMessage(res)}`)
        const createdPolicy = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdPolicy?.id })
        created.push(spec.name)
      }
    }

    const parts = [`${created.length} created`, `${updated.length} updated`]
    return {
      success: true,
      message: `ASR policies deployed to ${graphHost}: ${parts.join(', ')}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `ASR policy deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List the tenant's ASR-rules policies (name/id/templateReference); throws on a non-OK response. */
export async function listAsrPolicies(client: IntuneClient): Promise<LivePolicy[]> {
  const res = await client.getAll<LivePolicy>('/deviceManagement/configurationPolicies')
  if (!res.ok) {
    throw new Error(`Failed to list configuration policies: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items.filter(isAsrPolicy)
}

/** GET a single policy with its settings expanded (for drift/health/rollback capture). */
export async function getPolicyWithSettings(client: IntuneClient, id: string): Promise<LivePolicy | null> {
  const res = await client.request('GET', `/deviceManagement/configurationPolicies/${id}`, { query: { $expand: 'settings' } })
  if (!res.ok) return null
  return parseJson<LivePolicy>(res.body)
}
