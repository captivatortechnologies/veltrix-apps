import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { desiredFromItem, parseRepository } from './_shared'

/**
 * Validate repo-autolinks items: a non-empty `owner/repo`, a non-empty key
 * prefix, and a URL template that contains the `<num>` placeholder GitHub
 * requires. Static — no target access required. (repository, key_prefix) is
 * the identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one autolink.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const desired = desiredFromItem(item.fields)
    const parsed = parseRepository(desired.repository)

    if (!desired.repository) {
      errors.push({ field: `items[${i}].repository`, message: 'Repository is required.', code: 'EMPTY_REPOSITORY' })
    } else if (!parsed) {
      errors.push({
        field: `items[${i}].repository`,
        message: `Repository must be in "owner/repo" form (got "${desired.repository}").`,
        code: 'INVALID_REPOSITORY',
      })
    }

    if (!desired.keyPrefix) {
      errors.push({ field: `items[${i}].key_prefix`, message: 'Key prefix is required.', code: 'EMPTY_KEY_PREFIX' })
    }
    if (!desired.urlTemplate) {
      errors.push({ field: `items[${i}].url_template`, message: 'URL template is required.', code: 'EMPTY_URL_TEMPLATE' })
    } else if (!desired.urlTemplate.includes('<num>')) {
      errors.push({
        field: `items[${i}].url_template`,
        message: 'URL template must contain the "<num>" placeholder for the reference number.',
        code: 'MISSING_NUM_PLACEHOLDER',
      })
    }

    if (parsed && desired.keyPrefix) {
      const key = `${desired.repository.toLowerCase()}::${desired.keyPrefix.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].key_prefix`,
          message: `Autolink "${desired.keyPrefix}" on ${desired.repository} is listed more than once; the last one wins.`,
          code: 'DUPLICATE_AUTOLINK',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
