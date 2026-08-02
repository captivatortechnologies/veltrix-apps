import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SECURITY_ACTIONS, readRuleFields } from './_shared'

/**
 * Validate ACL rule items: a numeric Site ID, a non-empty name (≤255 chars), a
 * known security action, and a filter that is either empty (always run) or a
 * plausible expression (≤2000 chars). Static — no target access required. The rule
 * NAME is the identity WITHIN a site, so a duplicate (siteId, name) pair is flagged
 * (last one wins).
 */
const SITE_ID_RE = /^[0-9]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one ACL rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const { siteId, name, action, filter } = readRuleFields(item.fields)

    if (!siteId) {
      errors.push({ field: `items[${i}].siteId`, message: 'Site ID is required.', code: 'EMPTY_SITE_ID' })
    } else if (!SITE_ID_RE.test(siteId)) {
      errors.push({ field: `items[${i}].siteId`, message: `Site ID "${siteId}" must be numeric.`, code: 'INVALID_SITE_ID' })
    }

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Rule name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > 255) {
      errors.push({ field: `items[${i}].name`, message: 'Rule name must be 255 characters or fewer.', code: 'NAME_TOO_LONG' })
    } else if (siteId) {
      const key = `${siteId}::${name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Rule "${name}" is listed more than once for site ${siteId}; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!action) {
      errors.push({ field: `items[${i}].action`, message: 'An action is required.', code: 'EMPTY_ACTION' })
    } else if (!SECURITY_ACTIONS.has(action)) {
      errors.push({
        field: `items[${i}].action`,
        message: `Action "${action}" is not a supported security action. Use one of: ${[...SECURITY_ACTIONS].join(', ')}.`,
        code: 'INVALID_ACTION',
      })
    }

    if (filter.length > 2000) {
      errors.push({ field: `items[${i}].filter`, message: 'Filter must be 2000 characters or fewer.', code: 'FILTER_TOO_LONG' })
    } else if (!filter) {
      warnings.push({
        field: `items[${i}].filter`,
        message: `Rule "${name || i}" has an empty filter — the action will run on EVERY request to site ${siteId || '(unset)'}.`,
        code: 'EMPTY_FILTER',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
