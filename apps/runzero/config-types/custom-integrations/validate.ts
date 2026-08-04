import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { text } from './_shared'

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/

/**
 * Validate Custom Integration items: a non-empty name is required (it doubles as the identity),
 * and — per the spec's own field description — must not contain spaces (a hard error, cheap to
 * catch client-side). The icon, if set, is loosely checked for base64 shape (warning only — this
 * app does not decode/inspect the image). Static — no target access required. A duplicate name is
 * flagged (last wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom integration.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = text(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Integration name is required.', code: 'EMPTY_NAME' })
    } else if (/\s/.test(name)) {
      errors.push({ field: `items[${i}].name`, message: `Integration name "${name}" must not contain spaces.`, code: 'NAME_HAS_SPACES' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Integration name "${name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(name.toLowerCase())
    }

    const icon = text(item.fields.iconBase64)
    if (icon && !BASE64_RE.test(icon)) {
      warnings.push({
        field: `items[${i}].iconBase64`,
        message: 'Icon does not look like valid base64 — runZero may reject it.',
        code: 'SUSPECT_ICON_BASE64',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
