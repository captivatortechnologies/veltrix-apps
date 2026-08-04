import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString } from '../../lib/coerce'
import { buildDecoratorBody } from './_shared'

/**
 * Validate decorator items: a non-empty type and well-formed config JSON.
 * This config type assumes at most one decorator of a given type per stream
 * (or globally, when stream_title is blank) — a declared duplicate (stream,
 * type) pair is flagged, last one wins. Static — no target access, so an
 * unresolvable stream title and per-type required config keys surface at
 * deploy time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one decorator.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const type = asString(item.fields.type)
    const streamTitle = asString(item.fields.stream_title)
    const key = `${streamTitle}|${type}`

    if (!type) {
      errors.push({ field: `items[${i}].type`, message: 'Decorator type is required.', code: 'EMPTY_TYPE' })
    } else if (seen.has(key)) {
      warnings.push({ field: `items[${i}].type`, message: `A "${type}" decorator is already declared for ${streamTitle || 'the global (all streams)'} scope; the last one wins.`, code: 'DUPLICATE_DECORATOR' })
    } else {
      seen.add(key)
    }

    // Stream id is resolved at deploy time — pass '' here (identity check only, no target access).
    const { error } = buildDecoratorBody(item.fields, '')
    if (error) {
      errors.push({ field: `items[${i}].config`, message: error, code: 'INVALID_CONFIG_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
