import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'
import { EMAIL_TEMPLATE_NAMES } from './_shared'

/**
 * Validate Auth0 email template items: a known fixed template name, a non-empty
 * subject and body, and (when set) a non-negative URL lifetime. Static — no
 * target access required. The template name is the upsert identity (Auth0 has a
 * fixed set of templates, so a duplicate declares the same one twice — last one
 * wins, flagged as a warning).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one email template.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const template = readString(item.fields.template)
    const subject = readString(item.fields.subject)
    const body = readString(item.fields.body)

    if (!template) {
      errors.push({ field: `items[${i}].template`, message: 'Template is required.', code: 'EMPTY_TEMPLATE' })
    } else if (!EMAIL_TEMPLATE_NAMES.has(template)) {
      errors.push({
        field: `items[${i}].template`,
        message: `"${template}" is not one of Auth0's fixed email template names (${[...EMAIL_TEMPLATE_NAMES].join(', ')}).`,
        code: 'INVALID_TEMPLATE',
      })
    } else if (seen.has(template)) {
      warnings.push({ field: `items[${i}].template`, message: `Template "${template}" is declared more than once; the last one wins.`, code: 'DUPLICATE_TEMPLATE' })
    } else {
      seen.add(template)
    }

    if (!subject) {
      errors.push({ field: `items[${i}].subject`, message: 'Subject is required.', code: 'EMPTY_SUBJECT' })
    }
    if (!body) {
      errors.push({ field: `items[${i}].body`, message: 'Body is required.', code: 'EMPTY_BODY' })
    }

    const urlLifetime = item.fields.url_lifetime_in_seconds
    if (urlLifetime !== undefined && urlLifetime !== '' && Number(urlLifetime) < 0) {
      errors.push({
        field: `items[${i}].url_lifetime_in_seconds`,
        message: 'URL lifetime must be zero or a positive number of seconds.',
        code: 'INVALID_URL_LIFETIME',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
