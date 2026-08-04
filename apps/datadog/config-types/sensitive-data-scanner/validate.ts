import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  MAX_NAME_LENGTH,
  MAX_PRIORITY,
  MIN_PRIORITY,
  PRODUCTS,
  TEXT_REPLACEMENT_TYPES,
  extractGroupSpecs,
  groupKey,
  isJsonObject,
  parseJsonArray,
  ruleKey,
  type GroupSpec,
} from './_shared'

/**
 * Validate Sensitive Data Scanner group + rule items — static, no network
 * access.
 *   - group name required, <= 255 chars, unique across the canvas.
 *   - product_list required, every entry a supported product.
 *   - rules is required and must parse as a non-empty JSON array; each rule
 *     needs a name (unique within its group), exactly one of
 *     pattern/standard_pattern_id, a priority 1-5 when set, is_enabled a
 *     boolean when set, and a supported text_replacement.type when set.
 *   - Per-pattern regex syntax and standard_pattern_id existence are NOT
 *     validated here (no network access) — Datadog's own API is the final
 *     arbiter.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Scanning Group.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors)
    if (spec.name) {
      const key = groupKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Duplicate group name "${spec.name}" — each name may only be declared once (groups are matched by name).`,
          code: 'DUPLICATE_GROUP_NAME',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: GroupSpec, i: number, errors: ValidationError[]): void {
  const prefix = `items[${i}]`

  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Group name is required.', code: 'EMPTY_NAME' })
  } else if (spec.name.length > MAX_NAME_LENGTH) {
    errors.push({ field: `${prefix}.name`, message: `Group name must be ${MAX_NAME_LENGTH} characters or fewer.`, code: 'NAME_TOO_LONG' })
  }

  if (spec.productList.length === 0) {
    errors.push({ field: `${prefix}.product_list`, message: 'At least one product is required.', code: 'EMPTY_PRODUCT_LIST' })
  }
  for (const product of spec.productList) {
    if (!PRODUCTS.includes(product as (typeof PRODUCTS)[number])) {
      errors.push({
        field: `${prefix}.product_list`,
        message: `Product must be one of ${PRODUCTS.join(', ')} (got "${product}").`,
        code: 'INVALID_PRODUCT',
      })
    }
  }

  if (!spec.rulesRaw) {
    errors.push({ field: `${prefix}.rules`, message: 'Rules is required — at least one rule object.', code: 'EMPTY_RULES' })
    return
  }
  const parsed = parseJsonArray(spec.rulesRaw)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.rules`, message: 'Rules must be a valid JSON array.', code: 'INVALID_RULES_JSON' })
    return
  }
  if (!parsed.value || parsed.value.length === 0) {
    errors.push({ field: `${prefix}.rules`, message: 'At least one rule is required.', code: 'EMPTY_RULES' })
    return
  }

  const seenRuleKeys = new Set<string>()
  parsed.value.forEach((r, ri) => {
    if (!isJsonObject(r)) {
      errors.push({ field: `${prefix}.rules[${ri}]`, message: 'Each rule must be a JSON object.', code: 'INVALID_RULE' })
      return
    }
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    if (!name) {
      errors.push({ field: `${prefix}.rules[${ri}].name`, message: 'Each rule needs a "name".', code: 'EMPTY_RULE_NAME' })
    } else {
      const key = ruleKey(name)
      if (seenRuleKeys.has(key)) {
        errors.push({ field: `${prefix}.rules[${ri}].name`, message: `Duplicate rule name "${name}" within this group.`, code: 'DUPLICATE_RULE_NAME' })
      }
      seenRuleKeys.add(key)
    }

    const hasPattern = typeof r.pattern === 'string' && r.pattern.trim().length > 0
    const hasStandardPattern = typeof r.standard_pattern_id === 'string' && r.standard_pattern_id.trim().length > 0
    if (hasPattern === hasStandardPattern) {
      errors.push({
        field: `${prefix}.rules[${ri}]`,
        message: 'Each rule needs EXACTLY ONE of "pattern" (custom regex) or "standard_pattern_id" (a built-in pattern), not both and not neither.',
        code: 'INVALID_PATTERN_CHOICE',
      })
    }

    if ('priority' in r) {
      const priority = r.priority
      if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < MIN_PRIORITY || priority > MAX_PRIORITY) {
        errors.push({
          field: `${prefix}.rules[${ri}].priority`,
          message: `priority must be an integer between ${MIN_PRIORITY} and ${MAX_PRIORITY}.`,
          code: 'INVALID_PRIORITY',
        })
      }
    }
    if ('is_enabled' in r && typeof r.is_enabled !== 'boolean') {
      errors.push({ field: `${prefix}.rules[${ri}].is_enabled`, message: 'is_enabled must be a boolean.', code: 'INVALID_IS_ENABLED' })
    }
    if (isJsonObject(r.text_replacement)) {
      const type = r.text_replacement.type
      if (!TEXT_REPLACEMENT_TYPES.includes(type as (typeof TEXT_REPLACEMENT_TYPES)[number])) {
        errors.push({
          field: `${prefix}.rules[${ri}].text_replacement.type`,
          message: `text_replacement.type must be one of ${TEXT_REPLACEMENT_TYPES.join(', ')} (got "${String(type)}").`,
          code: 'INVALID_TEXT_REPLACEMENT_TYPE',
        })
      }
    } else if (r.text_replacement !== undefined) {
      errors.push({ field: `${prefix}.rules[${ri}].text_replacement`, message: 'text_replacement must be a JSON object.', code: 'INVALID_TEXT_REPLACEMENT' })
    }
  })
}
