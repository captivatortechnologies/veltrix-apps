import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { endpointGroupKey, extractEndpointGroupSpecs } from './_shared'

const NAME_FORBIDDEN_RE = /[#,+"\\<>;]/
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const GROUP_TYPES = ['computer', 'server']

/**
 * Validate endpoint group(s): a required unique `name` (excluding
 * Sophos's forbidden characters), a known `type`, and endpoint ids that look
 * like UUIDs. Static — no target access (a genuinely invalid endpoint id only
 * surfaces at deploy time from Sophos's own 404).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one endpoint group.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractEndpointGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Group name is required.', code: 'REQUIRED' })
    } else if (NAME_FORBIDDEN_RE.test(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: `Name "${spec.name}" contains a forbidden character (# , + " \\ < > ;).`, code: 'INVALID_NAME' })
    } else {
      const key = endpointGroupKey(spec.name)
      if (seen.has(key)) {
        warnings.push({ field: `${prefix}.name`, message: `Group "${spec.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Endpoint type is required.', code: 'REQUIRED' })
    } else if (!GROUP_TYPES.includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `"${spec.type}" must be one of ${GROUP_TYPES.join(', ')}.`, code: 'INVALID_TYPE' })
    }

    spec.endpointIds.forEach((id, idx) => {
      if (!UUID_RE.test(id)) {
        warnings.push({
          field: `${prefix}.endpointIds[${idx}]`,
          message: `"${id}" does not look like a Sophos endpoint UUID.`,
          code: 'UNUSUAL_ENDPOINT_ID',
        })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
