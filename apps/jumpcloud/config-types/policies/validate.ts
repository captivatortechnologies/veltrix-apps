import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractPolicySpecs, parsePolicyValues } from './_shared'

/**
 * Validate Policy items: a non-empty, unique name (the logical identity), a
 * required Policy Template Id, and a well-formed `values` JSON array. Static — no
 * target access required.
 *
 * Because policies are template-based and the config-field ids are tenant- and
 * template-specific, a policy without values is accepted but warned about (it
 * will deploy with the template defaults).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractPolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 255) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    } else if (seen.has(spec.name.toLowerCase())) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate Policy "${spec.name}" — each name may only be declared once per canvas.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (!spec.templateId) {
      errors.push({
        field: `${prefix}.templateId`,
        message: 'Policy Template Id is required — a policy is an instance of a Policy Template.',
        code: 'EMPTY_TEMPLATE',
      })
    }

    const parsed = parsePolicyValues(spec.valuesRaw)
    if (parsed.error) {
      errors.push({ field: `${prefix}.values`, message: parsed.error, code: 'INVALID_VALUES' })
    } else if (parsed.values.length === 0) {
      warnings.push({
        field: `${prefix}.values`,
        message:
          `"${spec.name || 'policy'}" declares no values — it will deploy with the template's ` +
          'default configuration. Supply values to override specific template fields.',
        code: 'NO_VALUES',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
