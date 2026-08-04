import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, specFromItem } from './_shared'

/** Validate Allowed Protocols items: a non-empty, uniquely-named service within ERS's length limits. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Allowed Protocols service.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = specFromItem(item)

    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'Service name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `items[${i}].name`,
        message: `Service name must be ${MAX_NAME_LENGTH} characters or fewer (got ${spec.name.length}).`,
        code: 'NAME_TOO_LONG',
      })
    } else {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Service name "${spec.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!spec.allowPapAscii && !spec.allowChap && !spec.allowMsChapV1 && !spec.allowMsChapV2 && !spec.allowEapMd5 && !spec.allowLeap && !spec.allowEapTls && !spec.allowPeap && !spec.allowEapTtls && !spec.allowEapFast && !spec.allowTeap) {
      warnings.push({ field: `items[${i}]`, message: 'No authentication method is enabled — this service will reject every request.', code: 'NO_METHOD_ENABLED' })
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
