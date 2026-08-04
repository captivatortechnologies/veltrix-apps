import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { str, ASSET_TYPES, MAX_SEVERITIES, CIA_LEVELS } from './_shared'

/**
 * Validate asset items: each needs an organization handle, an identifier and a
 * known asset type; severity / CIA fields, when set, must be known values.
 * Static — no target access required. Identity is (organization_handle +
 * identifier), so an identifier repeated within the same organization is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one asset.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const organizationHandle = str(item.fields.organization_handle)
    const identifier = str(item.fields.identifier)
    const assetType = str(item.fields.asset_type)
    const maxSeverity = str(item.fields.max_severity) || 'none'
    const confidentiality = str(item.fields.confidentiality_requirement) || 'none'
    const integrity = str(item.fields.integrity_requirement) || 'none'
    const availability = str(item.fields.availability_requirement) || 'none'

    if (!organizationHandle) {
      errors.push({ field: `items[${i}].organization_handle`, message: 'Organization handle is required.', code: 'EMPTY_ORGANIZATION' })
    }

    if (!identifier) {
      errors.push({ field: `items[${i}].identifier`, message: 'Identifier is required.', code: 'EMPTY_IDENTIFIER' })
    } else if (organizationHandle) {
      const key = `${organizationHandle.toLowerCase()} ${identifier.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].identifier`,
          message: `Asset "${identifier}" is listed more than once for organization "${organizationHandle}"; the last one wins.`,
          code: 'DUPLICATE_ASSET',
        })
      } else {
        seen.add(key)
      }
    }

    if (!ASSET_TYPES.has(assetType)) {
      errors.push({
        field: `items[${i}].asset_type`,
        message: `Asset type must be one of ${[...ASSET_TYPES].join(', ')} (got "${assetType}").`,
        code: 'INVALID_ASSET_TYPE',
      })
    }

    if (!MAX_SEVERITIES.has(maxSeverity)) {
      errors.push({
        field: `items[${i}].max_severity`,
        message: `Max severity must be one of ${[...MAX_SEVERITIES].join(', ')} (got "${maxSeverity}").`,
        code: 'INVALID_MAX_SEVERITY',
      })
    }

    for (const [key, value] of [
      ['confidentiality_requirement', confidentiality],
      ['integrity_requirement', integrity],
      ['availability_requirement', availability],
    ] as const) {
      if (!CIA_LEVELS.has(value)) {
        errors.push({
          field: `items[${i}].${key}`,
          message: `${key} must be one of ${[...CIA_LEVELS].join(', ')} (got "${value}").`,
          code: 'INVALID_CIA_LEVEL',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
