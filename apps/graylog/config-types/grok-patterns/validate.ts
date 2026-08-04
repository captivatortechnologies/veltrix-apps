import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString } from '../../lib/coerce'

/** Grok pattern names must be word characters — Graylog's own naming convention. */
const GROK_NAME_REGEX = /^[A-Za-z0-9_]+$/

/**
 * Validate grok-pattern items: a non-empty name matching Graylog's naming
 * convention (word characters — a pattern is referenced as %{NAME} from other
 * patterns and from extractors/pipeline rules), and a non-empty pattern
 * definition. Static — no target access, so a pattern that references another
 * undefined %{OTHER_PATTERN} surfaces as a deploy-time error from Graylog.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one grok pattern.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = asString(item.fields.name)
    const pattern = String(item.fields.pattern ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Pattern name is required.', code: 'EMPTY_NAME' })
    } else if (!GROK_NAME_REGEX.test(name)) {
      errors.push({ field: `items[${i}].name`, message: `Pattern name "${name}" may only contain letters, digits and underscores (it is referenced as %{${name}}).`, code: 'INVALID_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Pattern name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!pattern) {
      errors.push({ field: `items[${i}].pattern`, message: 'Pattern definition is required.', code: 'EMPTY_PATTERN' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
