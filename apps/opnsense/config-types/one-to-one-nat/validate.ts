import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractOneToOneRuleSpecs, isValidNatReflection, isValidType, type OneToOneRuleSpec } from './_shared'

/**
 * Validate OPNsense 1:1 NAT configurations: a required description (this
 * app's own identity/label choice), a required interface, a required source
 * network, a required external address, a supported type/natreflection, a
 * sequence in [1,999999], and no embedded commas in `categories`.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs: OneToOneRuleSpec[] = extractOneToOneRuleSpecs(ctx.canvas)

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required', code: 'required' })
    }
    if (!spec.interfaceName) {
      errors.push({ field: `${prefix}.interface`, message: 'Interface is required', code: 'required' })
    }
    if (!spec.sourceNet) {
      errors.push({ field: `${prefix}.source_net`, message: 'Source is required', code: 'required' })
    }
    if (!spec.external) {
      errors.push({ field: `${prefix}.external`, message: 'External address is required', code: 'required' })
    }
    if (!isValidType(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Type must be binat or nat (got "${spec.type}")`, code: 'invalid_value' })
    }
    if (!isValidNatReflection(spec.natReflection)) {
      errors.push({
        field: `${prefix}.natreflection`,
        message: `NAT reflection must be default (blank), enable or disable (got "${spec.natReflection}")`,
        code: 'invalid_value',
      })
    }
    if (!Number.isInteger(spec.sequence) || spec.sequence < 1 || spec.sequence > 999999) {
      errors.push({ field: `${prefix}.sequence`, message: 'Sequence must be an integer between 1 and 999999', code: 'invalid_value' })
    }
    spec.categories.forEach((entry, j) => {
      if (entry.includes(',')) {
        errors.push({ field: `${prefix}.categories[${j}]`, message: `"${entry}" must not contain a comma`, code: 'invalid_entry' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
