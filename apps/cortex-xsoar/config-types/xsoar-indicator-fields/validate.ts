import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { CLI_NAME_RE, extractFieldSpecs, FIELD_TYPES_BY_KIND, RESERVED_CLI_NAMES_BY_KIND } from '../lib/xsoarFields'

const KIND = 'indicator' as const

export { extractFieldSpecs }

/**
 * Validate indicator-field configurations: a cliName is required, lowercase
 * alphanumeric, unique, and not one of XSOAR's reserved internal column names;
 * a display name and a supported type are required; and a field scoped to
 * specific indicator types (associatedToAll disabled) must declare at least one.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractFieldSpecs(ctx.canvas)
  const seen = new Set<string>()
  const validTypes = new Set(FIELD_TYPES_BY_KIND[KIND])
  const reserved = RESERVED_CLI_NAMES_BY_KIND[KIND]

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.cliName) {
      errors.push({ field: `${prefix}.cliName`, message: 'CLI name is required', code: 'required' })
      continue
    }
    if (!CLI_NAME_RE.test(spec.cliName)) {
      errors.push({
        field: `${prefix}.cliName`,
        message: `CLI name "${spec.cliName}" must be lowercase letters and digits only`,
        code: 'invalid_cli_name',
      })
    }
    if (reserved.has(spec.cliName)) {
      errors.push({
        field: `${prefix}.cliName`,
        message: `CLI name "${spec.cliName}" is reserved by XSOAR and cannot be used for a custom indicator field`,
        code: 'reserved_cli_name',
      })
    }
    if (seen.has(spec.cliName)) {
      errors.push({
        field: `${prefix}.cliName`,
        message: `Duplicate indicator field "${spec.cliName}" — each cliName may only be declared once`,
        code: 'duplicate_field',
      })
    }
    seen.add(spec.cliName)

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Display name is required', code: 'required' })
    }

    if (!validTypes.has(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Type "${spec.type}" is not a valid indicator-field type`,
        code: 'invalid_type',
      })
    }

    if (!spec.associatedToAll && spec.associatedTypes.length === 0) {
      warnings.push({
        field: `${prefix}.associatedTypes`,
        message: `Field "${spec.cliName}" is not associated with all indicator types but declares none — it will not appear on any indicator`,
        code: 'no_associated_types',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
