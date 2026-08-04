import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, SGT_NAME_RE, MIN_TAG_VALUE, MAX_TAG_VALUE, AUTO_VALUE, specFromItem } from './_shared'

/**
 * Validate SGT items: a non-empty, uniquely-named tag matching ISE's naming
 * rule (alnum + underscore, <=32 chars), and a tag value that is either -1
 * (auto-assign) or within 2-65519.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Security Group Tag.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = specFromItem(item)

    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'Tag name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH || !SGT_NAME_RE.test(spec.name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Tag name must be ${MAX_NAME_LENGTH} characters or fewer and contain only letters, numbers and underscores (got "${spec.name}").`,
        code: 'INVALID_NAME',
      })
    } else {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Tag name "${spec.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (spec.value !== AUTO_VALUE && (spec.value < MIN_TAG_VALUE || spec.value > MAX_TAG_VALUE)) {
      errors.push({
        field: `items[${i}].value`,
        message: `Tag value must be -1 (auto-assign) or between ${MIN_TAG_VALUE} and ${MAX_TAG_VALUE} (got ${spec.value}).`,
        code: 'INVALID_TAG_VALUE',
      })
    }

    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `items[${i}].description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.description.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
