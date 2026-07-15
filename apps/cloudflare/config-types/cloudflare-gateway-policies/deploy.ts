import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  MISSING_ACCOUNT_MESSAGE,
  type CloudflareClient,
} from '../../lib/cloudflare'
import {
  extractGatewayPolicySpecs,
  GATEWAY_RULES_PATH,
  parseJsonObject,
  type GatewayPolicySpec,
  type LiveGatewayPolicy,
} from './validate'

export interface GatewayPolicyRollbackEntry {
  name: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveGatewayPolicy
}

/**
 * Deploy Cloudflare Gateway (Zero Trust) policies via the API (account-scoped).
 *
 * Identity is the policy `name`: list /gateway/rules, match on the name, then PUT
 * an existing rule by id or POST a new one. Cloudflare assigns the server id; we
 * key on the name so re-runs update rather than duplicate. Account-scoped, so a
 * missing account id is a hard stop.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  if (!(await client.hasAccount())) {
    return { success: false, message: MISSING_ACCOUNT_MESSAGE }
  }

  const specs = extractGatewayPolicySpecs(ctx.canvas).filter((s) => s.name && s.action && s.traffic)
  const rollbackState: GatewayPolicyRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listGatewayPolicies(client)
    const byName = new Map(existing.filter((p) => p.name).map((p) => [p.name as string, p]))

    for (const spec of specs) {
      const label = spec.name
      const live = byName.get(spec.name)

      if (live && live.id) {
        rollbackState.push({ name: spec.name, label, existed: true, id: live.id, prior: live })
        const res = await client.account('PUT', `${GATEWAY_RULES_PATH}/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) throw new Error(`Failed to update gateway policy "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        const res = await client.account('POST', GATEWAY_RULES_PATH, { body: buildPayload(spec) })
        if (!res.ok) throw new Error(`Failed to create gateway policy "${label}": ${cloudflareErrorMessage(res)}`)
        const created = cloudflareResult<LiveGatewayPolicy>(res)
        if (!created?.id) throw new Error(`Gateway policy "${label}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} gateway policy(ies) for account of zone "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Gateway policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all Gateway rules in the account; throws on a non-OK response. */
export async function listGatewayPolicies(client: CloudflareClient): Promise<LiveGatewayPolicy[]> {
  const res = await client.accountGetAll<LiveGatewayPolicy>(GATEWAY_RULES_PATH)
  if (!res.ok) {
    throw new Error(
      `Failed to list gateway policies: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

function buildPayload(spec: GatewayPolicySpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    action: spec.action,
    enabled: spec.enabled,
    filters: spec.filters,
    traffic: spec.traffic,
  }
  if (spec.precedence !== undefined) payload.precedence = spec.precedence
  // rule_json carries advanced blocks (identity, device_posture, rule_settings);
  // merge its top-level keys onto the payload. Validate has already ensured it
  // parses to an object, so `value` is non-null when it was supplied.
  const extra = parseJsonObject(spec.ruleJson).value
  if (extra) Object.assign(payload, extra)
  return payload
}
