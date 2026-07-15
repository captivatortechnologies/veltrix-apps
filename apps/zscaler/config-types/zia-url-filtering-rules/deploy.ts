import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractUrlFilteringRuleSpecs,
  parseRuleObject,
  resolveOrder,
  type LiveUrlFilteringRule,
  type UrlFilteringRuleSpec,
} from './validate'

export interface UrlFilteringRuleRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /** Full prior object (as fetched) so an update can be PUT back verbatim. */
  prior?: Record<string, unknown>
}

/**
 * Deploy ZIA URL filtering rules via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /urlFilteringRules, match by
 * name, then PUT an existing rule or POST a new one. ZIA STAGES every write —
 * nothing takes effect until activation — so this writes all rules, then calls
 * activate() ONCE at the end. If activation fails the writes remain staged and
 * rollbackData is returned so the platform can revert them.
 *
 * ZIA ships a PROTECTED default rule that must never be modified or deleted: if a
 * live name-match is the default rule, deploy throws so the author renames.
 *
 * This is a JSON-body rule type: the big/type-specific criteria live in the
 * rule_json escape hatch (urlCategories, locations, groups, labels, …). The body
 * spreads that JSON first, then overlays the first-class fields (name, order,
 * state, action, protocols) so those always win — the NAME in particular can
 * never be overridden by the JSON.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractUrlFilteringRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: UrlFilteringRuleRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listUrlFilteringRules(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      // rule_json is validated upstream; re-parse here to build the API body and
      // to fail loudly rather than send a malformed criteria object.
      const ruleJson = spec.ruleJson ? parseRuleObject(spec.ruleJson) : undefined
      if (spec.ruleJson && ruleJson === null) {
        throw new Error(`URL filtering rule "${spec.name}": rule JSON is not a valid JSON object`)
      }

      const live = byName.get(spec.name)

      if (live && live.id != null) {
        // Refuse to touch the built-in default rule — never modify, never delete.
        if (isDefaultRule(live)) {
          throw new Error(`"${spec.name}" is the default rule and cannot be modified`)
        }
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: { ...live } })
        const res = await client.zia('PUT', `/urlFilteringRules/${live.id}`, {
          body: buildPayload(spec, ruleJson ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to update URL filtering rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/urlFilteringRules', {
          body: buildPayload(spec, ruleJson ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to create URL filtering rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveUrlFilteringRule>(res.body)
        if (created?.id == null) {
          throw new Error(`URL filtering rule "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA URL filtering rule(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedRules: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA URL filtering rule(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `URL filtering rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA URL filtering rules; throws on a non-OK response. */
export async function listUrlFilteringRules(client: ZscalerClient): Promise<LiveUrlFilteringRule[]> {
  const res = await client.ziaGetAll<LiveUrlFilteringRule>('/urlFilteringRules')
  if (!res.ok) {
    throw new Error(
      `Failed to list URL filtering rules: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a URL filtering rule by name; null when absent. */
export async function findUrlFilteringRule(
  client: ZscalerClient,
  name: string,
): Promise<LiveUrlFilteringRule | null> {
  const all = await listUrlFilteringRules(client)
  return all.find((r) => r.name === name) ?? null
}

/** True when a live rule is the protected built-in default rule (read-only). */
export function isDefaultRule(rule: LiveUrlFilteringRule): boolean {
  return rule.defaultRule === true || rule.isDefaultRule === true || rule.predefined === true
}

/**
 * Build the API body. The rule_json escape hatch (advanced criteria/references)
 * is spread first so the first-class fields overlaid below always win — the name
 * can never be overridden by the JSON. protocols defaults to a single ANY_RULE.
 */
function buildPayload(
  spec: UrlFilteringRuleSpec,
  ruleJson: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...(ruleJson ?? {}),
    name: spec.name,
    order: resolveOrder(spec),
    state: spec.state,
    action: spec.action,
    protocols: spec.protocols.length ? spec.protocols : ['ANY_RULE'],
  }
}
