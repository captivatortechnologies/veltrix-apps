import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient, visionOneWriteError, type VisionOneClient } from '../../lib/visionOneApi'
import {
  CUSTOM_RULE_ENDPOINTS,
  buildCustomRuleBody,
  customRuleItemPath,
  extractCustomRuleFields,
  findRuleByName,
  parseJsonArray,
  ruleIdFromResponse,
  rulesFromResponse,
  type CustomRule,
} from './_shared'

/**
 * Deploy Cloud Risk Management custom rules over the Trend Vision One BETA API,
 * reconciled BY NAME (the config-as-code identity, since the rule id is
 * server-assigned):
 *   list:   GET    beta/cloudPosture/customRules            → identity match
 *   update: PATCH  beta/cloudPosture/customRules/{id}        when found
 *   create: POST   beta/cloudPosture/customRules             when not found
 *
 * When a create response does not carry the new rule's id, this falls back to
 * re-listing and matching by name so rollback can still target it for delete.
 *
 * rollbackData.previous carries every change made (the prior full rule body for
 * rules we UPDATED, the new id for rules we CREATED) so rollback can fully undo
 * a partial deploy.
 */

export interface CustomRuleRollbackEntry {
  name: string
  /** Prior full rule body when we UPDATED an existing rule (restore target); null when we CREATED it. */
  prior: CustomRule | null
  /** Id assigned when we CREATED a new rule (delete target); null when unresolved or we updated. */
  createdId: string | null
}

/** Best-effort read of the live custom-rule list for identity matching. */
async function listRules(client: VisionOneClient): Promise<CustomRule[]> {
  try {
    const res = await client.getBeta(CUSTOM_RULE_ENDPOINTS.list)
    if (!res.ok) return []
    return rulesFromResponse(res.json)
  } catch {
    return []
  }
}

/** Re-list and match by name when a create response did not carry the new id. */
async function resolveCreatedId(client: VisionOneClient, name: string): Promise<string | null> {
  const live = await listRules(client)
  return findRuleByName(live, name)?.id ?? null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for custom-rule deployment' }
  }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: CustomRuleRollbackEntry[] = []
  const applied: string[] = []

  try {
    const live = await listRules(client)

    for (const item of items) {
      const fields = extractCustomRuleFields(item.fields)
      if (!fields.name) continue

      const { value: attributes } = parseJsonArray(fields.attributesRaw, 'Attributes')
      const { value: eventRules } = parseJsonArray(fields.eventRulesRaw, 'Event rules')
      if (!attributes || !eventRules) continue // malformed JSON — validate() should have already caught this

      const body = buildCustomRuleBody(fields, attributes, eventRules)
      const match = findRuleByName(live, fields.name)

      if (match?.id) {
        const res = await client.patchBeta(customRuleItemPath(match.id), body)
        const error = visionOneWriteError(res)
        if (error) {
          return {
            success: false,
            message: `Custom-rule deploy failed updating "${fields.name}": ${error}`,
            artifacts: { applied },
            rollbackData: { previous },
          }
        }
        previous.push({ name: fields.name, prior: match, createdId: null })
      } else {
        const res = await client.postBeta(CUSTOM_RULE_ENDPOINTS.create, body)
        const error = visionOneWriteError(res)
        if (error) {
          return {
            success: false,
            message: `Custom-rule deploy failed creating "${fields.name}": ${error}`,
            artifacts: { applied },
            rollbackData: { previous },
          }
        }
        const createdId = ruleIdFromResponse(res.json) ?? (await resolveCreatedId(client, fields.name))
        previous.push({ name: fields.name, prior: null, createdId })
      }

      applied.push(fields.name)
    }

    if (applied.length === 0) {
      return { success: true, message: 'No custom rules to apply.', artifacts: { applied: [] }, rollbackData: { previous: [] } }
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom rule(s): ${applied.join(', ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom-rule deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
