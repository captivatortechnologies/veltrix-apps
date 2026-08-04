import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { str } from './_shared'

/**
 * Validate attribute items: a non-empty attribute type name, a non-empty short
 * name and long name within Password Safe's length limits, and (when set) a
 * description within its limit. Static — no target access required; the
 * attribute type is resolved/created at deploy time, not here. The (attribute
 * type, short name) pair is the identity, so a duplicate is flagged (last one
 * wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one attribute.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const attributeTypeName = str(item.fields.attributeTypeName)
    const shortName = str(item.fields.shortName)
    const longName = str(item.fields.longName)
    const description = str(item.fields.description)

    if (!attributeTypeName) {
      errors.push({ field: `items[${i}].attributeTypeName`, message: 'Attribute type is required.', code: 'EMPTY_ATTRIBUTE_TYPE' })
    }

    if (!shortName) {
      errors.push({ field: `items[${i}].shortName`, message: 'Short name is required.', code: 'EMPTY_SHORT_NAME' })
    } else if (shortName.length > 64) {
      errors.push({ field: `items[${i}].shortName`, message: 'Short name must be 64 characters or fewer.', code: 'SHORT_NAME_TOO_LONG' })
    }

    if (!longName) {
      errors.push({ field: `items[${i}].longName`, message: 'Long name is required.', code: 'EMPTY_LONG_NAME' })
    } else if (longName.length > 64) {
      errors.push({ field: `items[${i}].longName`, message: 'Long name must be 64 characters or fewer.', code: 'LONG_NAME_TOO_LONG' })
    }

    if (description.length > 255) {
      errors.push({ field: `items[${i}].description`, message: 'Description must be 255 characters or fewer.', code: 'DESCRIPTION_TOO_LONG' })
    }

    if (attributeTypeName && shortName) {
      const identity = `${attributeTypeName.toLowerCase()} ${shortName.toLowerCase()}`
      if (seen.has(identity)) {
        warnings.push({ field: `items[${i}].shortName`, message: `Attribute ${shortName} in type ${attributeTypeName} is listed more than once; the last one wins.`, code: 'DUPLICATE_ATTRIBUTE' })
      } else {
        seen.add(identity)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
