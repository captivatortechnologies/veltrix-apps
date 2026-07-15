import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractSandboxRuleSpecs, type LiveSandboxRule, type SandboxRuleSpec } from './validate'

export interface SandboxRuleRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /** The full prior live rule, captured verbatim for a faithful PUT restore. */
  prior?: LiveSandboxRule
}

/**
 * Deploy ZIA sandbox (advanced threat) rules via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /sandboxRules, match by name,
 * then PUT an existing rule or POST a new one. This is a JSON-body rule type —
 * the request body is `{ name, order, state, ...rule_json }`, where the
 * escape-hatch JSON carries the Sandbox action (`ba_rule_action`) and any
 * advanced criteria; `name` and `order` are always taken from the first-class
 * fields and never overridden by the JSON.
 *
 * ZIA STAGES every write — nothing takes effect until activation — so this
 * writes all rules, then calls activate() ONCE at the end. If activation fails
 * the writes remain staged and rollbackData is returned so the platform can
 * revert them.
 *
 * The built-in DEFAULT sandbox rule is protected: if a name matches a live rule
 * flagged as the default (defaultRule / isDefaultRule / predefined), deploy
 * throws so the author renames rather than overwriting it. It is NEVER deleted.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractSandboxRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: SandboxRuleRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listSandboxRules(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && isProtectedRule(live)) {
        throw new Error(
          `"${spec.name}" matches the predefined default sandbox rule and cannot be modified — the default rule is managed by Zscaler; rename your rule`,
        )
      }

      if (live && live.id != null) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.zia('PUT', `/sandboxRules/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update sandbox rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/sandboxRules', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create sandbox rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveSandboxRule>(res.body)
        if (created?.id == null) {
          throw new Error(`Sandbox rule "${spec.name}" was created but the API returned no id`)
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
        message: `Staged ${deployed.length} ZIA sandbox rule(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedRules: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA sandbox rule(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sandbox rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA sandbox rules; throws on a non-OK response. */
export async function listSandboxRules(client: ZscalerClient): Promise<LiveSandboxRule[]> {
  const res = await client.ziaGetAll<LiveSandboxRule>('/sandboxRules')
  if (!res.ok) {
    throw new Error(
      `Failed to list sandbox rules: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a sandbox rule by name; null when absent. */
export async function findSandboxRule(
  client: ZscalerClient,
  name: string,
): Promise<LiveSandboxRule | null> {
  const all = await listSandboxRules(client)
  return all.find((r) => r.name === name) ?? null
}

/** True when a live rule is the protected built-in default (never modify/delete). */
export function isProtectedRule(rule: LiveSandboxRule): boolean {
  return rule.defaultRule === true || rule.isDefaultRule === true || rule.predefined === true
}

/**
 * Build the request body for a sandbox rule. First-class scalars form the base;
 * the rule_json escape hatch is spread over them so advanced criteria (and the
 * Sandbox action) win — EXCEPT `name` and `order`, which are re-applied last so
 * the canvas identity and evaluation order can never be overridden by the JSON.
 */
function buildPayload(spec: SandboxRuleSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    order: spec.order,
    state: spec.state,
    ...(spec.ruleJson ?? {}),
  }
  body.name = spec.name
  body.order = spec.order
  return body
}
