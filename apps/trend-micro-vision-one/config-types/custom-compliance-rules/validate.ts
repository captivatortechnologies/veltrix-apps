import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { PROVIDERS, RISK_LEVELS, RULE_CATEGORIES, extractCustomRuleFields, normalizeName, parseJsonArray } from './_shared'

/**
 * Validate custom-compliance-rule items: a required name/description, at least
 * one known category, a known risk level + provider, required service +
 * resourceType, and well-formed non-empty JSON arrays for `attributes` and
 * `eventRules`. Static — no target access required. Only that `attributes` /
 * `eventRules` parse as JSON arrays is checked (their nested item shape is large
 * and vendor-specific — Vision One validates it server-side at deploy time; a
 * light shape check WARNS rather than errors, see below). The name doubles as
 * the rule's identity, so a duplicate name is flagged (last one wins).
 */
const MAX_NAME = 255
const MAX_DESCRIPTION = 2000
const MAX_TEXT = 128

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const prefix = `items[${i}]`
    const fields = extractCustomRuleFields(item.fields)

    if (!fields.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (fields.name.length > MAX_NAME) {
      errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME} characters or fewer.`, code: 'NAME_TOO_LONG' })
    } else {
      const key = normalizeName(fields.name)
      if (seen.has(key)) {
        warnings.push({ field: `${prefix}.name`, message: `Rule "${fields.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!fields.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required.', code: 'EMPTY_DESCRIPTION' })
    } else if (fields.description.length > MAX_DESCRIPTION) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_DESCRIPTION} characters or fewer.`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }

    if (fields.categories.length === 0) {
      errors.push({ field: `${prefix}.categories`, message: 'At least one category is required.', code: 'EMPTY_CATEGORIES' })
    } else {
      const unknown = fields.categories.filter((c) => !RULE_CATEGORIES.has(c))
      if (unknown.length > 0) {
        errors.push({
          field: `${prefix}.categories`,
          message: `Unknown categor${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')}.`,
          code: 'INVALID_CATEGORY',
        })
      }
    }

    if (!RISK_LEVELS.has(fields.riskLevel)) {
      errors.push({
        field: `${prefix}.riskLevel`,
        message: `Risk level must be one of ${[...RISK_LEVELS].join(', ')} (got "${fields.riskLevel}").`,
        code: 'INVALID_RISK_LEVEL',
      })
    }

    if (!PROVIDERS.has(fields.provider)) {
      errors.push({
        field: `${prefix}.provider`,
        message: `Provider must be one of ${[...PROVIDERS].join(', ')} (got "${fields.provider}").`,
        code: 'INVALID_PROVIDER',
      })
    }

    if (!fields.service) {
      errors.push({ field: `${prefix}.service`, message: 'Service is required.', code: 'EMPTY_SERVICE' })
    } else if (fields.service.length > MAX_TEXT) {
      errors.push({ field: `${prefix}.service`, message: `Service must be ${MAX_TEXT} characters or fewer.`, code: 'SERVICE_TOO_LONG' })
    }

    if (!fields.resourceType) {
      errors.push({ field: `${prefix}.resourceType`, message: 'Resource type is required.', code: 'EMPTY_RESOURCE_TYPE' })
    } else if (fields.resourceType.length > MAX_TEXT) {
      errors.push({
        field: `${prefix}.resourceType`,
        message: `Resource type must be ${MAX_TEXT} characters or fewer.`,
        code: 'RESOURCE_TYPE_TOO_LONG',
      })
    }

    const { value: attributes, error: attributesError } = parseJsonArray(fields.attributesRaw, 'Attributes')
    if (attributesError) {
      errors.push({ field: `${prefix}.attributes`, message: attributesError, code: 'INVALID_ATTRIBUTES_JSON' })
    } else if (!attributes || attributes.length === 0) {
      errors.push({ field: `${prefix}.attributes`, message: 'At least one attribute is required.', code: 'EMPTY_ATTRIBUTES' })
    } else {
      const malformed = attributes.some(
        (a) => !a || typeof a !== 'object' || Array.isArray(a) || typeof (a as Record<string, unknown>).name !== 'string' || typeof (a as Record<string, unknown>).path !== 'string',
      )
      if (malformed) {
        warnings.push({
          field: `${prefix}.attributes`,
          message: 'Each attribute is expected to have string "name" and "path" fields — VERIFY the exact schema against a live Vision One tenant.',
          code: 'ATTRIBUTE_SHAPE_UNVERIFIED',
        })
      }
    }

    const { value: eventRules, error: eventRulesError } = parseJsonArray(fields.eventRulesRaw, 'Event rules')
    if (eventRulesError) {
      errors.push({ field: `${prefix}.eventRules`, message: eventRulesError, code: 'INVALID_EVENT_RULES_JSON' })
    } else if (!eventRules || eventRules.length === 0) {
      errors.push({ field: `${prefix}.eventRules`, message: 'At least one event rule is required.', code: 'EMPTY_EVENT_RULES' })
    } else {
      const malformed = eventRules.some((r) => !r || typeof r !== 'object' || Array.isArray(r) || !('conditions' in (r as Record<string, unknown>)))
      if (malformed) {
        warnings.push({
          field: `${prefix}.eventRules`,
          message: 'Each event rule is expected to have a "conditions" field — VERIFY the exact schema against a live Vision One tenant.',
          code: 'EVENT_RULE_SHAPE_UNVERIFIED',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
