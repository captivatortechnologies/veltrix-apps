import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractIpsRuleSpecs,
  parsePositiveInt,
  parseRuleObject,
  DEFAULT_ORDER,
  type IpsRuleSpec,
  type LiveIpsRule,
} from './validate'

export interface IpsRuleRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /** The full prior live rule body, PUT back verbatim to restore it. */
  prior?: Record<string, unknown>
}

/**
 * Deploy ZIA firewall IPS rules via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /firewallIpsRules, match by
 * name, then PUT an existing rule or POST a new one. ZIA STAGES every write —
 * nothing takes effect until activation — so this writes all rules, then calls
 * activate() ONCE at the end. If activation fails the writes remain staged and
 * rollbackData is returned so the platform can revert them.
 *
 * The rule body merges a small set of managed first-class scalars (name, order,
 * state, action) with the optional rule_json escape hatch that supplies advanced
 * criteria. The first-class scalars always win so drift detection stays coherent,
 * and the NAME can never be taken from the JSON body.
 *
 * ZIA ships a PROTECTED default firewall IPS rule — if a declared name matches
 * the built-in default, deploy throws rather than modifying it, and rollback
 * never deletes it (it is never adopted into rollback state).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractIpsRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: IpsRuleRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listIpsRules(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      // Criteria are validated upstream; re-parse here to build the API body and
      // to fail loudly rather than send a malformed advanced body.
      const ruleJson = spec.ruleJson ? parseRuleObject(spec.ruleJson) : undefined
      if (spec.ruleJson && ruleJson === null) {
        throw new Error(`Firewall IPS rule "${spec.name}": advanced rule JSON is not a valid JSON object`)
      }

      const live = byName.get(spec.name)

      if (live && live.id != null) {
        // Never modify ZIA's protected built-in default rule.
        if (isDefaultRule(live)) {
          throw new Error(
            `"${spec.name}" is the predefined/default ZIA firewall IPS rule and cannot be modified — rename your rule so it does not collide with the built-in default.`,
          )
        }
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: capturePrior(live),
        })
        const res = await client.zia('PUT', `/firewallIpsRules/${live.id}`, {
          body: buildPayload(spec, ruleJson ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to update firewall IPS rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/firewallIpsRules', {
          body: buildPayload(spec, ruleJson ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to create firewall IPS rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveIpsRule>(res.body)
        if (created?.id == null) {
          throw new Error(`Firewall IPS rule "${spec.name}" was created but the API returned no id`)
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
        message: `Staged ${deployed.length} ZIA firewall IPS rule(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedRules: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA firewall IPS rule(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Firewall IPS rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA firewall IPS rules; throws on a non-OK response. */
export async function listIpsRules(client: ZscalerClient): Promise<LiveIpsRule[]> {
  const res = await client.ziaGetAll<LiveIpsRule>('/firewallIpsRules')
  if (!res.ok) {
    throw new Error(
      `Failed to list firewall IPS rules: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a firewall IPS rule by name; null when absent. */
export async function findIpsRule(client: ZscalerClient, name: string): Promise<LiveIpsRule | null> {
  const all = await listIpsRules(client)
  return all.find((r) => r.name === name) ?? null
}

/** True when a live rule is ZIA's protected built-in default (never modify/delete). */
export function isDefaultRule(rule: LiveIpsRule): boolean {
  return rule.isDefaultRule === true || rule.defaultRule === true || rule.predefined === true
}

/**
 * Build the /firewallIpsRules body. The JSON escape hatch fills advanced criteria
 * first; the managed first-class scalars are then re-asserted so they always win
 * (drift detection tracks order/action/state, and the NAME is the identity — it
 * can never be taken from the JSON body).
 */
function buildPayload(spec: IpsRuleSpec, ruleJson: Record<string, unknown> | undefined): Record<string, unknown> {
  const order = parsePositiveInt(spec.order) ?? DEFAULT_ORDER
  return {
    ...(ruleJson ?? {}),
    name: spec.name,
    order,
    state: spec.state,
    action: spec.action,
  }
}

/** Snapshot the full prior live rule so rollback can PUT it back verbatim. */
function capturePrior(rule: LiveIpsRule): Record<string, unknown> {
  return { ...rule }
}
