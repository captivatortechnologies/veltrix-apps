import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { DISTRIBUTIONS, YES_NO } from './_shared'

/**
 * Validate galaxy-cluster items: a non-empty galaxy reference and value, a known
 * distribution, a sharing group id when distribution is Sharing Group, and (when
 * provided) valid JSON elements. Static — no target access required. `galaxy` +
 * `value` together double as the cluster identity, so a duplicate pair is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one galaxy cluster.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const galaxy = String(item.fields.galaxy ?? '').trim()
    const value = String(item.fields.value ?? '').trim()
    const distribution = String(item.fields.distribution ?? '').trim()
    const sharingGroupId = item.fields.sharing_group_id
    const elements = String(item.fields.elements ?? '').trim()
    const publish = String(item.fields.publish ?? '').trim()

    if (!galaxy) {
      errors.push({ field: `items[${i}].galaxy`, message: 'Galaxy is required.', code: 'EMPTY_GALAXY' })
    }
    if (!value) {
      errors.push({ field: `items[${i}].value`, message: 'Value is required.', code: 'EMPTY_VALUE' })
    }

    if (galaxy && value) {
      const key = `${galaxy.toLowerCase()}::${value.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].value`, message: `Cluster "${value}" in galaxy "${galaxy}" is listed more than once; the last one wins.`, code: 'DUPLICATE_CLUSTER' })
      } else {
        seen.add(key)
      }
    }

    if (!DISTRIBUTIONS.has(distribution)) {
      errors.push({ field: `items[${i}].distribution`, message: `Distribution must be one of ${[...DISTRIBUTIONS].join(', ')} (got "${distribution}").`, code: 'INVALID_DISTRIBUTION' })
    } else if (distribution === '4' && (sharingGroupId === undefined || sharingGroupId === '' || !Number.isFinite(Number(sharingGroupId)))) {
      errors.push({ field: `items[${i}].sharing_group_id`, message: 'Sharing Group ID is required when Distribution is Sharing Group.', code: 'MISSING_SHARING_GROUP' })
    }

    if (publish && !YES_NO.has(publish)) {
      errors.push({ field: `items[${i}].publish`, message: `Publish must be yes or no (got "${publish}").`, code: 'INVALID_PUBLISH' })
    }

    if (elements) {
      try {
        const parsed = JSON.parse(elements)
        if (!Array.isArray(parsed)) {
          errors.push({ field: `items[${i}].elements`, message: 'Elements must be a JSON array of { key, value } objects.', code: 'INVALID_ELEMENTS' })
        }
      } catch {
        errors.push({ field: `items[${i}].elements`, message: 'Elements must be valid JSON.', code: 'INVALID_JSON' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
