import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeColor, normalizeName } from './_shared'

/**
 * Validate tag items: a non-empty, well-formed name (letters / digits / space and
 * a small set of separators, within Darktrace's length budget), an optional HSL
 * hue in 0–360, and a description within a 256-char limit. Static — no target
 * access. The tag NAME is the identity, so a duplicate name is flagged.
 */
const NAME_RE = /^[A-Za-z0-9 ._:-]+$/
const MAX_NAME = 128
const MAX_DESCRIPTION = 256
const MIN_HUE = 0
const MAX_HUE = 360

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one tag.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = normalizeName(item.fields.name)
    const description = String(item.fields.description ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Tag name is required.', code: 'EMPTY_NAME' })
    } else {
      if (name.length > MAX_NAME) {
        errors.push({ field: `items[${i}].name`, message: `Tag name must be at most ${MAX_NAME} characters.`, code: 'NAME_TOO_LONG' })
      }
      if (!NAME_RE.test(name)) {
        errors.push({ field: `items[${i}].name`, message: `Tag name "${name}" has invalid characters — use letters, digits, spaces and . _ : -`, code: 'INVALID_NAME' })
      }
    }

    const rawColor = item.fields.color
    if (rawColor !== undefined && rawColor !== null && String(rawColor).trim() !== '') {
      const color = normalizeColor(rawColor)
      if (color === null) {
        errors.push({ field: `items[${i}].color`, message: 'Color must be an integer HSL hue (0–360).', code: 'INVALID_COLOR' })
      } else if (color < MIN_HUE || color > MAX_HUE) {
        errors.push({ field: `items[${i}].color`, message: `Color hue must be between ${MIN_HUE} and ${MAX_HUE}.`, code: 'COLOR_OUT_OF_RANGE' })
      }
    }

    if (description.length > MAX_DESCRIPTION) {
      errors.push({ field: `items[${i}].description`, message: `Description must be at most ${MAX_DESCRIPTION} characters.`, code: 'DESCRIPTION_TOO_LONG' })
    }

    if (name) {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Tag "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TAG' })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
