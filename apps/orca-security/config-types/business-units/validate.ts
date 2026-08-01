import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { CRITICALITIES, BU_FILTER_JSON_KEY } from './_shared'
import { normalizeStringList } from '../../lib/reconcile'

/**
 * Validate business-unit items: a non-empty name (the identity), a known
 * criticality (when set), a scope filter that carries values (when a filter type
 * is chosen) and the API's "up to 2" bound on contact emails / deployment
 * stages. Static — no target access required. A duplicate name is flagged.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one business unit.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const criticality = String(item.fields.businessCriticality ?? '').trim()
    const filterType = String(item.fields.filterType ?? '').trim()
    const filterValues = normalizeStringList(item.fields.filterValues)
    const contactEmails = normalizeStringList(item.fields.contactEmails)
    const deploymentStages = normalizeStringList(item.fields.deploymentStages)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Business unit name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Business unit name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (criticality && !CRITICALITIES.has(criticality)) {
      errors.push({
        field: `items[${i}].businessCriticality`,
        message: `Criticality must be one of low, medium, high, critical (got "${criticality}").`,
        code: 'INVALID_CRITICALITY',
      })
    }

    if (filterType) {
      if (!BU_FILTER_JSON_KEY[filterType]) {
        errors.push({ field: `items[${i}].filterType`, message: `Unknown filter type "${filterType}".`, code: 'INVALID_FILTER_TYPE' })
      } else if (filterValues.length === 0) {
        errors.push({
          field: `items[${i}].filterValues`,
          message: 'Choose at least one value for the selected scope filter (or set the filter to "Org-wide").',
          code: 'EMPTY_FILTER_VALUES',
        })
      }
    }

    if (contactEmails.length > 2) {
      errors.push({ field: `items[${i}].contactEmails`, message: 'Orca accepts at most 2 contact emails.', code: 'TOO_MANY_EMAILS' })
    }
    if (deploymentStages.length > 2) {
      errors.push({ field: `items[${i}].deploymentStages`, message: 'Orca accepts at most 2 deployment stages.', code: 'TOO_MANY_STAGES' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
