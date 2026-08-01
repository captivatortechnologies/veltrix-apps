import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  desiredFromItem,
  parseJsonArray,
  parseJsonObject,
  RULESET_TARGETS,
  RULESET_ENFORCEMENTS,
} from './_shared'

/**
 * Validate ruleset items: a non-empty owner + name, a valid target /
 * enforcement, and well-formed JSON for rules / conditions / bypass_actors.
 * Static — no target access required. (owner, repository, name) is the identity,
 * so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one ruleset.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const desired = desiredFromItem(item.fields)

    if (!desired.owner) {
      errors.push({ field: `items[${i}].owner`, message: 'Owner is required.', code: 'EMPTY_OWNER' })
    }
    if (!desired.name) {
      errors.push({ field: `items[${i}].name`, message: 'Ruleset name is required.', code: 'EMPTY_NAME' })
    }

    if (desired.owner && desired.name) {
      const key = `${desired.owner.toLowerCase()}/${desired.repository.toLowerCase()}/${desired.name.toLowerCase()}`
      if (seen.has(key)) {
        const scope = desired.repository ? `${desired.owner}/${desired.repository}` : desired.owner
        warnings.push({
          field: `items[${i}].name`,
          message: `Ruleset "${desired.name}" on ${scope} is listed more than once; the last one wins.`,
          code: 'DUPLICATE_RULESET',
        })
      } else {
        seen.add(key)
      }
    }

    if (!RULESET_TARGETS.includes(desired.target as (typeof RULESET_TARGETS)[number])) {
      errors.push({
        field: `items[${i}].target`,
        message: `Target must be one of ${RULESET_TARGETS.join(', ')} (got "${desired.target}").`,
        code: 'INVALID_TARGET',
      })
    }
    if (!RULESET_ENFORCEMENTS.includes(desired.enforcement as (typeof RULESET_ENFORCEMENTS)[number])) {
      errors.push({
        field: `items[${i}].enforcement`,
        message: `Enforcement must be one of ${RULESET_ENFORCEMENTS.join(', ')} (got "${desired.enforcement}").`,
        code: 'INVALID_ENFORCEMENT',
      })
    }

    const rules = parseJsonArray(desired.rulesRaw)
    if (rules.error) {
      errors.push({ field: `items[${i}].rules`, message: `Rules JSON is invalid — ${rules.error}.`, code: 'INVALID_RULES_JSON' })
    } else if (rules.value.length === 0) {
      warnings.push({
        field: `items[${i}].rules`,
        message: 'This ruleset declares no rules — it will apply no protections.',
        code: 'NO_RULES',
      })
    }

    const conditions = parseJsonObject(desired.conditionsRaw)
    if (conditions.error) {
      errors.push({
        field: `items[${i}].conditions`,
        message: `Conditions JSON is invalid — ${conditions.error}.`,
        code: 'INVALID_CONDITIONS_JSON',
      })
    }

    const bypass = parseJsonArray(desired.bypassActorsRaw)
    if (bypass.error) {
      errors.push({
        field: `items[${i}].bypass_actors`,
        message: `Bypass actors JSON is invalid — ${bypass.error}.`,
        code: 'INVALID_BYPASS_JSON',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
