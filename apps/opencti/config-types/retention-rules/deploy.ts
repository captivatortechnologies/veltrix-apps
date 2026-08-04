import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_RETENTION_RULE_MUTATION,
  LIST_RETENTION_RULES_QUERY,
  PATCH_RETENTION_RULE_MUTATION,
  buildRetentionRuleInput,
  buildRetentionRulePatch,
  findRetentionRule,
  retentionRulesFromList,
  type OpenctiRetentionRule,
} from './_shared'

/**
 * Deploy OpenCTI retention rules over the GraphQL API:
 *   read (rollback): retentionRules                → find the live rule by name
 *   create:          retentionRuleAdd(input) with { name, scope, max_retention, retention_unit?, filters?, active? }
 *   update:          retentionRuleEdit(id) { fieldPatch(input) } with [EditInput] (rule exists)
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per
 * rule, the prior node (null when it did not exist) AND the id — so rollback
 * can restore the prior body or delete the one we created.
 *
 * NOTE: retentionRuleAdd returns the created rule (with its new id).
 */
async function listRetentionRules(base: string, headers: Record<string, string>): Promise<OpenctiRetentionRule[]> {
  try {
    return retentionRulesFromList(await graphql<unknown>(base, headers, LIST_RETENTION_RULES_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for retention-rule deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; ruleId: string | null; rule: OpenctiRetentionRule | null }> = []
  const applied: string[] = []

  try {
    const live = await listRetentionRules(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findRetentionRule(live, name)

      if (existing && existing.id != null) {
        const input = buildRetentionRulePatch(item.fields)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_RETENTION_RULE_MUTATION, { id: existing.id, input })
        }
        previous.push({ name, ruleId: String(existing.id), rule: existing })
      } else {
        const created = await graphql<{ retentionRuleAdd?: OpenctiRetentionRule }>(base, headers, ADD_RETENTION_RULE_MUTATION, {
          input: buildRetentionRuleInput(item.fields),
        })
        const newId = created?.retentionRuleAdd?.id ?? null
        previous.push({ name, ruleId: newId ? String(newId) : null, rule: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} retention rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Retention-rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
