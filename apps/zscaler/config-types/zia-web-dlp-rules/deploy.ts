import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  DEFAULT_RULE_ORDER,
  extractWebDlpRuleSpecs,
  isProtectedDefaultRule,
  parseRuleObject,
  type LiveWebDlpRule,
  type WebDlpRuleSpec,
} from './validate'

export interface WebDlpRuleRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /** The full prior rule body, captured so an update can be restored verbatim. */
  prior?: Record<string, unknown>
}

/**
 * Deploy ZIA web DLP rules via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /webDlpRules, match by name,
 * then PUT an existing rule or POST a new one. ZIA STAGES every write — nothing
 * takes effect until activation — so this writes all rules, then calls
 * activate() ONCE at the end. If activation fails the writes remain staged and
 * rollbackData is returned so the platform can revert them.
 *
 * A web DLP rule is a JSON-body policy rule: a small set of first-class scalar
 * fields (name, order, state, action, protocols) is merged with the `rule_json`
 * escape hatch (dlpEngines[], labels[], etc.). JSON keys win for advanced
 * fields, but the rule name always comes from the name field.
 *
 * The built-in DEFAULT (catch-all) web DLP rule is PROTECTED: if a declared name
 * matches it, deploy throws so the author renames rather than overwriting it. It
 * is never modified and never deleted.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractWebDlpRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: WebDlpRuleRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listWebDlpRules(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && isProtectedDefaultRule(live)) {
        throw new Error(
          `"${spec.name}" is the protected default web DLP rule and cannot be modified — rename your rule to manage a custom one`,
        )
      }

      // Escape-hatch JSON is validated upstream; re-parse here to build the body
      // and to fail loudly rather than send a malformed rule.
      const ruleJson = spec.ruleJson ? parseRuleObject(spec.ruleJson) : undefined
      if (spec.ruleJson && ruleJson === null) {
        throw new Error(`Web DLP rule "${spec.name}": advanced criteria is not a valid JSON object`)
      }

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          // Capture the full live rule so rollback restores advanced fields too.
          prior: live as unknown as Record<string, unknown>,
        })
        const res = await client.zia('PUT', `/webDlpRules/${live.id}`, {
          body: buildPayload(spec, ruleJson ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to update web DLP rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/webDlpRules', {
          body: buildPayload(spec, ruleJson ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to create web DLP rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveWebDlpRule>(res.body)
        if (created?.id == null) {
          throw new Error(`Web DLP rule "${spec.name}" was created but the API returned no id`)
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
        message: `Staged ${deployed.length} ZIA web DLP rule(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedRules: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA web DLP rule(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Web DLP rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA web DLP rules; throws on a non-OK response. */
export async function listWebDlpRules(client: ZscalerClient): Promise<LiveWebDlpRule[]> {
  const res = await client.ziaGetAll<LiveWebDlpRule>('/webDlpRules')
  if (!res.ok) {
    throw new Error(
      `Failed to list web DLP rules: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a web DLP rule by name; null when absent. */
export async function findWebDlpRule(
  client: ZscalerClient,
  name: string,
): Promise<LiveWebDlpRule | null> {
  const all = await listWebDlpRules(client)
  return all.find((r) => r.name === name) ?? null
}

/**
 * Build the API body for a web DLP rule. The first-class scalars are applied,
 * then the rule_json escape hatch is spread over them (JSON keys win for
 * advanced fields), and finally the name is forced from the name field so the
 * escape hatch can never hijack the rule's identity.
 */
function buildPayload(
  spec: WebDlpRuleSpec,
  ruleJson: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    order: spec.order ?? DEFAULT_RULE_ORDER,
    state: spec.state,
    action: spec.action,
    protocols: spec.protocols,
    ...(ruleJson ?? {}),
  }
  // Identity is the name — never let the JSON escape hatch override it.
  body.name = spec.name
  return body
}
