import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { AUTHENTICATION_REQUIREMENTS, FLOW_DESIGNATIONS, SLUG_PATTERN } from './_shared'

/**
 * Validate authentik Flow items: a non-empty name and title, a slug matching
 * authentik's `^[-a-zA-Z0-9_]+$` pattern (the item's identity — also the
 * `{slug}` path segment), a known `designation` (required by authentik), and
 * — when set — a known `authentication` requirement. A duplicate slug is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one flow.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const slug = String(item.fields.slug ?? '').trim()
    const title = String(item.fields.title ?? '').trim()
    const designation = String(item.fields.designation ?? '').trim()
    const authentication = String(item.fields.authentication ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Flow name is required.', code: 'EMPTY_NAME' })
    }

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Flow title is required.', code: 'EMPTY_TITLE' })
    }

    if (!slug) {
      errors.push({ field: `items[${i}].slug`, message: 'Slug is required.', code: 'EMPTY_SLUG' })
    } else if (!SLUG_PATTERN.test(slug)) {
      errors.push({
        field: `items[${i}].slug`,
        message: `Slug "${slug}" may only contain letters, numbers, hyphens and underscores.`,
        code: 'INVALID_SLUG',
      })
    } else if (seen.has(slug)) {
      warnings.push({
        field: `items[${i}].slug`,
        message: `Slug "${slug}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_SLUG',
      })
    } else {
      seen.add(slug)
    }

    if (!designation) {
      errors.push({ field: `items[${i}].designation`, message: 'Designation is required.', code: 'EMPTY_DESIGNATION' })
    } else if (!FLOW_DESIGNATIONS.has(designation)) {
      errors.push({ field: `items[${i}].designation`, message: `Unsupported designation "${designation}".`, code: 'INVALID_DESIGNATION' })
    }

    if (authentication && !AUTHENTICATION_REQUIREMENTS.has(authentication)) {
      errors.push({
        field: `items[${i}].authentication`,
        message: `Unsupported authentication requirement "${authentication}".`,
        code: 'INVALID_AUTHENTICATION',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
