import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * Validate Splunk SOAR connection profiles.
 *
 * A connection profile only names/describes how the platform reaches a SOAR
 * instance — the actual endpoint, credential, and connectivity are resolved
 * from the targeted `soar-instance` component at deploy time. The canvas
 * therefore only needs a non-empty, unique connection name per section.
 */

const MAX_NAME_LENGTH = 120

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const names = new Set<string>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = `${section.name}`

    const name = fields.name as string | undefined
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      errors.push({ field: `${prefix}.name`, message: 'Connection name is required', code: 'required' })
      continue
    }

    if (name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Connection name must be ${MAX_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (names.has(name)) {
      errors.push({ field: `${prefix}.name`, message: `Duplicate connection name: "${name}"`, code: 'duplicate' })
    }
    names.add(name)
  }

  return { valid: errors.length === 0, errors, warnings }
}
