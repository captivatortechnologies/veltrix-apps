import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractShaperRuleSpecs, isValidDirection, isValidProtocol, type ShaperRuleSpec } from './_shared'

function rejectEmbeddedCommas(prefix: string, field: string, entries: string[], errors: ValidationResult['errors']) {
  entries.forEach((entry, j) => {
    if (entry.includes(',')) {
      errors.push({ field: `${prefix}.${field}[${j}]`, message: `"${entry}" must not contain a comma`, code: 'invalid_entry' })
    }
  })
}

/**
 * Validate OPNsense traffic-shaper-rules configurations: a required
 * description (this app's own identity/label choice — shaper rules have no
 * required field of their own to use), a required interface, a required
 * target pipe/queue name, a supported protocol/direction, a sequence in
 * [1,1000000], and no embedded commas in comma-joined list fields.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs: ShaperRuleSpec[] = extractShaperRuleSpecs(ctx.canvas)

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required', code: 'required' })
    }
    if (!spec.interfaceName) {
      errors.push({ field: `${prefix}.interface`, message: 'Interface is required', code: 'required' })
    }
    if (!spec.targetName) {
      errors.push({ field: `${prefix}.target_name`, message: 'A target pipe or queue name is required', code: 'required' })
    }
    if (!isValidProtocol(spec.proto)) {
      errors.push({ field: `${prefix}.proto`, message: `Protocol "${spec.proto}" is not recognized`, code: 'invalid_value' })
    }
    if (!isValidDirection(spec.direction)) {
      errors.push({ field: `${prefix}.direction`, message: `Direction must be blank (both), in, or out (got "${spec.direction}")`, code: 'invalid_value' })
    }
    if (!Number.isInteger(spec.sequence) || spec.sequence < 1 || spec.sequence > 1000000) {
      errors.push({ field: `${prefix}.sequence`, message: 'Sequence must be an integer between 1 and 1000000', code: 'invalid_value' })
    }

    rejectEmbeddedCommas(prefix, 'source', spec.source, errors)
    rejectEmbeddedCommas(prefix, 'destination', spec.destination, errors)
    rejectEmbeddedCommas(prefix, 'dscp', spec.dscp, errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}
