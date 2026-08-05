import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  MISSING_ACCOUNT_MESSAGE,
  type CloudflareClient,
} from '../../lib/cloudflare'
import {
  extractPostureRuleSpecs,
  parseJsonArray,
  parseJsonObject,
  postureRuleKey,
  type LivePostureRule,
  type PostureRuleSpec,
} from './validate'

export interface PostureRuleRollbackEntry {
  name: string
  label: string
  existed: boolean
  id?: string
  prior?: LivePostureRule
}

/**
 * Deploy Cloudflare device posture rules via the API (account-scoped).
 *
 * Identity is the rule `name`: list /devices/posture, match on the name, then
 * PUT an existing rule by id or POST a new one.
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

  const specs = extractPostureRuleSpecs(ctx.canvas).filter((s) => s.name && s.inputJson.trim())
  const rollbackState: PostureRuleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listPostureRules(client)
    const byKey = new Map(existing.filter((r) => r.name).map((r) => [postureRuleKey(r.name as string), r]))

    for (const spec of specs) {
      const label = spec.name
      const key = postureRuleKey(spec.name)
      const live = byKey.get(key)
      const body = buildPayload(spec)

      if (live && live.id) {
        rollbackState.push({ name: spec.name, label, existed: true, id: live.id, prior: live })
        const res = await client.account('PUT', `/devices/posture/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update posture rule "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        const res = await client.account('POST', '/devices/posture', { body })
        if (!res.ok) throw new Error(`Failed to create posture rule "${label}": ${cloudflareErrorMessage(res)}`)
        const created = cloudflareResult<LivePostureRule>(res)
        if (!created?.id) throw new Error(`Posture rule "${label}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} device posture rule(s) to account for "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Device posture rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all device posture rules in the account; throws on a non-OK response. */
export async function listPostureRules(client: CloudflareClient): Promise<LivePostureRule[]> {
  const res = await client.accountGetAll<LivePostureRule>('/devices/posture')
  if (!res.ok) {
    throw new Error(
      `Failed to list device posture rules: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Build the create/update body from a spec; match is only sent when non-empty. */
export function buildPayload(spec: PostureRuleSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    type: spec.type,
    input: parseJsonObject(spec.inputJson).value ?? {},
  }
  if (spec.description) body.description = spec.description
  if (spec.schedule) body.schedule = spec.schedule
  if (spec.expiration) body.expiration = spec.expiration
  const match = parseJsonArray(spec.matchJson).value
  if (match && match.length > 0) body.match = match
  return body
}
