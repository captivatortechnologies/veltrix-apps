import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isPageTemplateSupported } from '../../lib/thehiveApi'

/**
 * Validate page-template items: a non-empty title, category and content.
 * Static — no target access required. The title is the stable identity, so a
 * duplicate title is flagged (last one wins). A warning is raised when the
 * seam is pointed at TheHive 4, since deploy will refuse to run at all.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (!isPageTemplateSupported()) {
    warnings.push({ field: 'items', message: 'Page Templates require TheHive 5 — the app is currently configured for TheHive 4 (lib/thehiveApi.ts API_VERSION); deploy will fail.', code: 'V5_ONLY' })
  }

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one page template.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const title = String(item.fields.title ?? '').trim()
    const category = String(item.fields.category ?? '').trim()
    const content = String(item.fields.content ?? '').trim()

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Page template title is required.', code: 'EMPTY_TITLE' })
    } else if (seen.has(title)) {
      warnings.push({ field: `items[${i}].title`, message: `Page template title "${title}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TITLE' })
    } else {
      seen.add(title)
    }

    if (!category) {
      errors.push({ field: `items[${i}].category`, message: 'Page template category is required.', code: 'EMPTY_CATEGORY' })
    }
    if (!content) {
      errors.push({ field: `items[${i}].content`, message: 'Page template content is required.', code: 'EMPTY_CONTENT' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
