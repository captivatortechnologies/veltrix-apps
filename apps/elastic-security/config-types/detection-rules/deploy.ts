import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, parseJson, elasticErrorMessage, type ElasticClient } from '../../lib/elastic'
import {
  extractRuleSpecs,
  isPrebuiltRule,
  parseRuleObject,
  stripServerFields,
  type LiveRule,
  type RuleSpec,
} from './validate'

export interface RuleRollbackEntry {
  ruleId: string
  existed: boolean
  /** Internal object id of the live rule (captured for reference; PUT matches by rule_id). */
  id?: string
  /** Prior live rule body, captured for restoring an updated rule on rollback. */
  prior?: LiveRule
}

/**
 * Deploy detection rules to an Elastic deployment via the Kibana Detections API.
 *
 * A rule's logical identity is its `rule_id`. The Detections API has NO native
 * upsert, so each declared rule is reconciled by hand:
 *   - GET  /api/detection_engine/rules?rule_id={rule_id}   (404 = absent)
 *   - POST /api/detection_engine/rules                     — create when absent
 *   - PUT  /api/detection_engine/rules  (rule_id in BODY)  — full-replace when present
 *
 * buildRuleBody merges the freeform Definition JSON, then FORCES rule_id / name /
 * enabled from the modelled fields so they always win. It strips server-managed
 * fields and NEVER sends `version` (custom-rule version is create-only, stays 1).
 *
 * PROTECTED — Elastic PREBUILT rules: if a live rule matching a rule_id is
 * prebuilt (immutable === true OR rule_source.type === "external") the deploy
 * FAILS loudly. Prebuilt rules are Elastic-managed and are never modified,
 * replaced or deleted by this app.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, kibanaUrl } = built

  const specs = extractRuleSpecs(ctx.canvas).filter((s) => s.ruleId && s.name && s.ruleJson)
  const rollbackState: RuleRollbackEntry[] = []
  const createdRuleIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.ruleId

      // Definition is validated upstream; re-parse here to build the API body and
      // to fail loudly rather than send a malformed rule.
      const ruleObj = spec.ruleJson ? parseRuleObject(spec.ruleJson) : null
      if (!ruleObj) {
        throw new Error(`Rule "${label}": Definition is not a valid JSON object`)
      }

      const existing = await getRuleByRuleId(client, spec.ruleId)

      if (existing) {
        // PROTECTED: never touch an Elastic prebuilt rule. Fail the whole deploy
        // so a mistaken rule_id collision with a shipped rule is impossible to
        // silently overwrite.
        if (isPrebuiltRule(existing)) {
          throw new Error(
            `Rule "${label}" matches an Elastic PREBUILT rule (immutable / rule_source="external"). ` +
              'Prebuilt rules are Elastic-managed and must not be modified, replaced or deleted — ' +
              'choose a different rule_id for your custom rule.',
          )
        }

        // Capture the full prior body so rollback can restore it.
        rollbackState.push({ ruleId: spec.ruleId, existed: true, id: existing.id, prior: existing })

        const res = await client.kibana('PUT', '/api/detection_engine/rules', {
          body: buildRuleBody(spec, ruleObj),
        })
        if (!res.ok) {
          throw new Error(`Failed to update rule "${label}": ${elasticErrorMessage(res)}`)
        }
      } else {
        const res = await client.kibana('POST', '/api/detection_engine/rules', {
          body: buildRuleBody(spec, ruleObj),
        })
        if (!res.ok) {
          throw new Error(`Failed to create rule "${label}": ${elasticErrorMessage(res)}`)
        }
        const created = parseJson<LiveRule>(res.body)
        rollbackState.push({ ruleId: spec.ruleId, existed: false, id: created?.id })
        createdRuleIds.push(spec.ruleId)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} detection rule(s) to Elastic at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { kibanaUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdRuleIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Detection-rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { kibanaUrl, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdRuleIds },
    }
  }
}

// --- Helpers ---

/**
 * Fetch a rule by its `rule_id`; null on 404 (absent). The Detections read
 * endpoint takes rule_id as a query param and 404s when no rule has it.
 */
export async function getRuleByRuleId(client: ElasticClient, ruleId: string): Promise<LiveRule | null> {
  const res = await client.kibana('GET', '/api/detection_engine/rules', { query: { rule_id: ruleId } })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read rule "${ruleId}": ${elasticErrorMessage(res)}`)
  }
  return parseJson<LiveRule>(res.body)
}

/**
 * Build the create/update body: merge the Definition JSON, strip server-managed
 * fields, drop `version` (create-only — stays 1), then FORCE the modelled
 * identity/lifecycle fields so rule_id / name / enabled always win over anything
 * inside the blob. The same body works for POST (create) and PUT (full replace):
 * PUT matches by the `rule_id` carried in the body, so the internal `id` is
 * intentionally NOT sent (avoids an id/rule_id conflict on the full-replace path).
 */
export function buildRuleBody(spec: RuleSpec, ruleJson: Record<string, unknown>): Record<string, unknown> {
  const body = stripServerFields(ruleJson)
  // version is create-only for custom rules and must NEVER be sent on update;
  // dropping it on create too lets Kibana assign the canonical version 1.
  delete body.version
  body.rule_id = spec.ruleId
  body.name = spec.name
  body.enabled = spec.enabled
  return body
}
