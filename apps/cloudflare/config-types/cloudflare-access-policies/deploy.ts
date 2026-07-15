import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  MISSING_ACCOUNT_MESSAGE,
  type CloudflareClient,
} from '../../lib/cloudflare'
import {
  extractAccessPolicySpecs,
  parseJsonArray,
  type AccessPolicySpec,
  type LiveAccessPolicy,
} from './validate'

export interface AccessPolicyRollbackEntry {
  name: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveAccessPolicy
}

/**
 * Deploy Cloudflare reusable Access policies via the API (account-scoped).
 *
 * Identity is the policy name: list /access/policies, match on the name, then PUT
 * an existing policy by id or POST a new one. Cloudflare assigns the server id; we
 * key on the name so re-runs update rather than duplicate. Account-scoped, so a
 * resolvable account id is required.
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

  const specs = extractAccessPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: AccessPolicyRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listAccessPolicies(client)
    const byName = new Map(existing.filter((p) => p.name).map((p) => [p.name as string, p]))

    for (const spec of specs) {
      const label = spec.name
      const live = byName.get(spec.name)
      const body = buildPayload(spec)

      if (live && live.id) {
        rollbackState.push({ name: spec.name, label, existed: true, id: live.id, prior: live })
        const res = await client.account('PUT', `/access/policies/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update Access policy "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        const res = await client.account('POST', '/access/policies', { body })
        if (!res.ok) throw new Error(`Failed to create Access policy "${label}": ${cloudflareErrorMessage(res)}`)
        const created = cloudflareResult<LiveAccessPolicy>(res)
        if (!created?.id) throw new Error(`Access policy "${label}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Access policy(ies): ${deployed.join(', ')}`,
      artifacts: { domain, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Access policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all reusable Access policies in the account; throws on a non-OK response. */
export async function listAccessPolicies(client: CloudflareClient): Promise<LiveAccessPolicy[]> {
  const res = await client.accountGetAll<LiveAccessPolicy>('/access/policies')
  if (!res.ok) {
    throw new Error(
      `Failed to list Access policies: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Build the Cloudflare Access policy body from a canvas spec. */
export function buildPayload(spec: AccessPolicySpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    decision: spec.decision,
    include: parseJsonArray(spec.includeJson).value ?? [],
  }
  const require = parseJsonArray(spec.requireJson).value
  if (require && require.length > 0) payload.require = require
  const exclude = parseJsonArray(spec.excludeJson).value
  if (exclude && exclude.length > 0) payload.exclude = exclude
  return payload
}
