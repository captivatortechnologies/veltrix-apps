import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractLocalSiteSpecs, localSiteKey } from './_shared'

/**
 * Validate local site(s): a required `url`, either a categoryId (1-57) or at
 * least one tag, and uniqueness per url. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one local site.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractLocalSiteSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.url) {
      errors.push({ field: `${prefix}.url`, message: 'URL is required.', code: 'REQUIRED' })
    } else {
      const key = localSiteKey(spec.url)
      if (seen.has(key)) {
        warnings.push({ field: `${prefix}.url`, message: `URL "${spec.url}" is listed more than once; the last one wins.`, code: 'DUPLICATE_URL' })
      } else {
        seen.add(key)
      }
    }

    if (spec.categoryId !== undefined && (spec.categoryId < 1 || spec.categoryId > 57)) {
      errors.push({ field: `${prefix}.categoryId`, message: 'Category ID must be between 1 and 57.', code: 'INVALID_CATEGORY_ID' })
    }

    if (spec.categoryId === undefined && spec.tags.length === 0) {
      errors.push({ field: `${prefix}.categoryId`, message: 'Either a Category ID or at least one Tag is required.', code: 'REQUIRED' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
