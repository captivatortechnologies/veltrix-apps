import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractSslRuleSpecs,
  parseRuleObject,
  type SslRuleSpec,
  type LiveSslRule,
} from './validate'

export interface SslRuleRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /**
   * The full prior rule object, captured verbatim so rollback can PUT it back
   * unchanged. An SSL inspection rule carries many advanced criteria (srcIps,
   * urlCategories, deviceGroups, …) plus its `action` object; restoring only the
   * scalar fields would corrupt the rule, so the whole object is preserved.
   */
  prior?: LiveSslRule
}

/**
 * Deploy ZIA SSL inspection rules via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /sslInspectionRules, match by
 * name, then PUT an existing rule or POST a new one. ZIA STAGES every write —
 * nothing takes effect until activation — so this writes all rules, then calls
 * activate() ONCE at the end. If activation fails the writes remain staged and
 * rollbackData is returned so the platform can revert them.
 *
 * The built-in DEFAULT SSL inspection rule is PROTECTED: if a name matches a
 * live rule flagged as the default (isDefaultRule / defaultRule / predefined),
 * deploy throws so the author renames rather than overwriting it. It is NEVER
 * deleted.
 *
 * SPECIAL to SSL inspection: the action is an OBJECT, not a scalar, so it is NOT
 * a first-class field — it is carried inside rule_json under the `action` key.
 * The body is the parsed rule_json (which supplies `action` + advanced criteria)
 * with name/order/state layered on top so the first-class fields always win and
 * the JSON body can never rename the rule out from under its identity.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractSslRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: SslRuleRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listSslRules(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && isProtectedDefaultRule(live)) {
        throw new Error(
          `"${spec.name}" is a predefined/built-in SSL inspection rule (the default rule) and cannot be modified — rename your rule to manage a custom one`,
        )
      }

      if (live && live.id != null) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.zia('PUT', `/sslInspectionRules/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update SSL inspection rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/sslInspectionRules', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create SSL inspection rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveSslRule>(res.body)
        if (created?.id == null) {
          throw new Error(`SSL inspection rule "${spec.name}" was created but the API returned no id`)
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
        message: `Staged ${deployed.length} ZIA SSL inspection rule(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedRules: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA SSL inspection rule(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `SSL inspection rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA SSL inspection rules; throws on a non-OK response. */
export async function listSslRules(client: ZscalerClient): Promise<LiveSslRule[]> {
  const res = await client.ziaGetAll<LiveSslRule>('/sslInspectionRules')
  if (!res.ok) {
    throw new Error(
      `Failed to list SSL inspection rules: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find an SSL inspection rule by name; null when absent. */
export async function findSslRule(client: ZscalerClient, name: string): Promise<LiveSslRule | null> {
  const all = await listSslRules(client)
  return all.find((r) => r.name === name) ?? null
}

/** True when a live rule is the PROTECTED built-in default rule (never modify/delete). */
export function isProtectedDefaultRule(live: LiveSslRule): boolean {
  return live.isDefaultRule === true || live.defaultRule === true || live.predefined === true
}

/**
 * Build the API body: the parsed rule_json escape hatch first — it supplies the
 * SSL `action` OBJECT and any advanced criteria — then the first-class scalars
 * (name, order, state) layered on top so they always win. The `action` object
 * is never a first-class field for this rule type, so it flows through untouched
 * from rule_json; name/order/state are authoritative and the JSON body can never
 * rename the rule out from under its identity.
 */
function buildPayload(spec: SslRuleSpec): Record<string, unknown> {
  const ruleJson = spec.ruleJson ? parseRuleObject(spec.ruleJson) : null
  // Validated upstream; re-check here to fail loudly rather than send bad JSON.
  if (spec.ruleJson && ruleJson === null) {
    throw new Error(`SSL inspection rule "${spec.name}": rule JSON is not a valid JSON object`)
  }

  const order =
    spec.order !== undefined && Number.isInteger(spec.order) && spec.order > 0 ? spec.order : 1

  return {
    ...(ruleJson ?? {}),
    // First-class fields win over any same-named JSON keys; the SSL `action`
    // object (not a first-class field) passes through from rule_json above.
    name: spec.name,
    order,
    state: spec.state,
  }
}
