import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonField } from '../../lib/reconcile'
import { isValidSectionsShape } from './_shared'

/**
 * Validate compliance-framework items: a non-empty name (the identity), a
 * non-empty description (required by the API) and sections that parse as a
 * JSON array of { name, tests: [{ rule_id, rule_id_in_framework }] }. Static —
 * no target access required. A duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom compliance framework.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const description = String(item.fields.description ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Framework name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Framework name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!description) {
      errors.push({ field: `items[${i}].description`, message: 'Description is required by the Orca API.', code: 'EMPTY_DESCRIPTION' })
    }

    const sections = parseJsonField(item.fields.sections, 'Sections')
    if (!sections.ok) {
      errors.push({ field: `items[${i}].sections`, message: sections.error, code: 'INVALID_SECTIONS' })
    } else if (!isValidSectionsShape(sections.value)) {
      errors.push({
        field: `items[${i}].sections`,
        message: 'Sections must be a JSON array of { name, tests: [{ rule_id, rule_id_in_framework }] }.',
        code: 'INVALID_SECTIONS',
      })
    } else if (sections.value.length === 0) {
      warnings.push({ field: `items[${i}].sections`, message: 'No sections declared — the framework will have no controls.', code: 'EMPTY_SECTIONS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
