import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, s1ErrorMessage, s1Result, type S1Client } from '../../lib/s1'
import { coerceValue, extractPolicySettingSpecs, setNestedPath } from './validate'

/** Deprecated top-level policy keys the API misbehaves on if round-tripped. */
const DEPRECATED_KEYS = ['agentNotification', 'agentUiOn']

/**
 * Deploy SentinelOne agent policy settings via the Management API. The policy is
 * a per-scope singleton: GET the current policy, merge the declared setting
 * overrides (dot-path keys), strip deprecated top-level keys, then PUT the merged
 * object (read-modify-write). The whole prior policy is captured for rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const pp = client.policyPath()
  if (pp.error || !pp.path) return { success: false, message: pp.error ?? 'scope not configured' }
  const path = pp.path

  const specs = extractPolicySettingSpecs(ctx.canvas).filter((s) => s.key && s.rawValue.trim() !== '')

  try {
    const current = await getPolicy(client, path)
    const merged: Record<string, unknown> = JSON.parse(JSON.stringify(current))
    for (const spec of specs) {
      setNestedPath(merged, spec.key, coerceValue(spec.rawValue, spec.valueType))
    }
    for (const key of DEPRECATED_KEYS) delete merged[key]

    const res = await client.request('PUT', path, { body: { data: merged } })
    if (!res.ok) throw new Error(`Failed to update the agent policy: ${s1ErrorMessage(res)}`)

    return {
      success: true,
      message: `Enforced ${specs.length} policy setting(s) on the ${client.currentScope} scope at ${consoleUrl}: ${specs
        .map((s) => s.key)
        .join(', ')}`,
      artifacts: { consoleUrl, scope: client.currentScope, settings: specs.map((s) => s.key) },
      rollbackData: { priorPolicy: current, path },
    }
  } catch (error) {
    return {
      success: false,
      message: `Agent policy deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { consoleUrl },
    }
  }
}

/** GET the scope's current policy object; throws on a non-OK response. */
export async function getPolicy(client: S1Client, path: string): Promise<Record<string, unknown>> {
  const res = await client.request('GET', path)
  if (!res.ok) throw new Error(`Failed to read the agent policy: ${s1ErrorMessage(res)}`)
  return s1Result<Record<string, unknown>>(res) ?? {}
}
