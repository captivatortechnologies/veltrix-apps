import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  type CloudflareClient,
} from '../../lib/cloudflare'
import {
  extractPageRuleSpecs,
  livePageRulePattern,
  OPERATOR,
  pageRuleKey,
  parseJsonArray,
  TARGET,
  type LivePageRule,
  type PageRuleSpec,
} from './validate'

export interface PageRuleRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LivePageRule
}

/**
 * Deploy classic Cloudflare Page Rules via the API (zone-scoped).
 *
 * Identity is the URL match pattern: list /pagerules, match on the pattern, then
 * PUT an existing rule by id (full replace) or POST a new one. Cloudflare assigns
 * the server id; we key on the URL pattern so re-runs update rather than
 * duplicate.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractPageRuleSpecs(ctx.canvas).filter((s) => s.urlPattern && s.actionsJson.trim())
  const rollbackState: PageRuleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listPageRules(client)
    const byKey = new Map(
      existing
        .map((r) => [pageRuleKey(livePageRulePattern(r)), r] as const)
        .filter(([key]) => key.length > 0),
    )

    for (const spec of specs) {
      const label = spec.urlPattern
      const live = byKey.get(spec.key)

      if (live && live.id) {
        rollbackState.push({ key: spec.key, label, existed: true, id: live.id, prior: live })
        const res = await client.zone('PUT', `/pagerules/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) throw new Error(`Failed to update Page Rule "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        const res = await client.zone('POST', '/pagerules', { body: buildPayload(spec) })
        if (!res.ok) throw new Error(`Failed to create Page Rule "${label}": ${cloudflareErrorMessage(res)}`)
        const created = cloudflareResult<LivePageRule>(res)
        if (!created?.id) throw new Error(`Page Rule "${label}" was created but the API returned no id`)
        rollbackState.push({ key: spec.key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Page Rule(s) to zone "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Page Rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with drift / healthCheck) ---

/**
 * List all Page Rules in the zone; throws on a non-OK response. The Page Rules
 * list endpoint returns the full set in one call (it is not paginated), so a
 * single GET is used rather than the paginating helper.
 */
export async function listPageRules(client: CloudflareClient): Promise<LivePageRule[]> {
  const res = await client.zone('GET', '/pagerules')
  if (!res.ok) {
    throw new Error(`Failed to list Page Rules: ${cloudflareErrorMessage(res)}`)
  }
  return cloudflareResult<LivePageRule[]>(res) ?? []
}

/** Build the Cloudflare Page Rule body from a canvas spec. */
export function buildPayload(spec: PageRuleSpec): Record<string, unknown> {
  return {
    targets: [{ target: TARGET, constraint: { operator: OPERATOR, value: spec.urlPattern } }],
    actions: buildActions(parseJsonArray(spec.actionsJson).value ?? []),
    priority: spec.priority,
    status: spec.enabled ? 'active' : 'disabled',
  }
}

/** Normalise a parsed actions array to {id, value?} objects the API accepts. */
export function buildActions(raw: unknown[]): Array<Record<string, unknown>> {
  return raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a))
    .map((a) => {
      const action: Record<string, unknown> = { id: a.id }
      // Some actions (e.g. disable_apps) carry no value — keep it only when present.
      if ('value' in a) action.value = a.value
      return action
    })
}
