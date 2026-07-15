import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractFirewallRuleSpecs,
  parseRuleObject,
  type FirewallRuleSpec,
  type LiveFirewallRule,
} from './validate'

export interface FirewallRuleRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /** The full live rule captured before update, PUT back verbatim on rollback. */
  prior?: LiveFirewallRule
}

/** The predefined/default firewall rule is read-only — deploy never touches it. */
export function isProtectedRule(rule: LiveFirewallRule): boolean {
  return rule.isDefaultRule === true || rule.defaultRule === true || rule.predefined === true
}

/**
 * Deploy ZIA cloud firewall filtering rules via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /firewallFilteringRules, match
 * by name, then PUT an existing rule or POST a new one. ZIA STAGES every write —
 * nothing takes effect until activation — so this writes all rules, then calls
 * activate() ONCE at the end. If activation fails the writes remain staged and
 * rollbackData is returned so the platform can revert them.
 *
 * The predefined DEFAULT firewall rule is read-only: if a name matches a live
 * rule flagged predefined/default, deploy throws so the author renames rather
 * than attempting to overwrite (or, worse, delete) a built-in rule.
 *
 * The body is `{ ...rule_json, name, order, state, action }` — the JSON escape
 * hatch supplies the type-specific matching criteria, and the first-class fields
 * always win over any same-named JSON keys.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractFirewallRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: FirewallRuleRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listFirewallRules(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && isProtectedRule(live)) {
        throw new Error(
          `"${spec.name}" is the predefined default firewall rule and cannot be modified — rename your rule to manage a custom one`,
        )
      }

      const body = buildPayload(spec)

      if (live && live.id != null) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.zia('PUT', `/firewallFilteringRules/${live.id}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to update firewall rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/firewallFilteringRules', { body })
        if (!res.ok) {
          throw new Error(`Failed to create firewall rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveFirewallRule>(res.body)
        if (created?.id == null) {
          throw new Error(`Firewall rule "${spec.name}" was created but the API returned no id`)
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
        message: `Staged ${deployed.length} ZIA firewall rule(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedRules: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA firewall rule(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Firewall rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA firewall filtering rules; throws on a non-OK response. */
export async function listFirewallRules(client: ZscalerClient): Promise<LiveFirewallRule[]> {
  const res = await client.ziaGetAll<LiveFirewallRule>('/firewallFilteringRules')
  if (!res.ok) {
    throw new Error(
      `Failed to list firewall rules: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a firewall rule by name; null when absent. */
export async function findFirewallRule(
  client: ZscalerClient,
  name: string,
): Promise<LiveFirewallRule | null> {
  const all = await listFirewallRules(client)
  return all.find((r) => r.name === name) ?? null
}

/**
 * Build the API body: the JSON escape hatch supplies the advanced/type-specific
 * criteria and the first-class scalar fields are layered on top so they always
 * win (name always from the name field; order defaults to 1 when blank).
 */
function buildPayload(spec: FirewallRuleSpec): Record<string, unknown> {
  const ruleJson = spec.ruleJson ? parseRuleObject(spec.ruleJson) : undefined
  if (spec.ruleJson && ruleJson === null) {
    // Validated upstream; re-checked here to fail loudly rather than send junk.
    throw new Error(`Firewall rule "${spec.name}": rule criteria is not a valid JSON object`)
  }
  return {
    ...(ruleJson ?? {}),
    name: spec.name,
    order: spec.order ?? 1,
    state: spec.state,
    action: spec.action,
  }
}
