import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, PROCESSOR_TYPES, extractPipelineSpecs, isJsonObject, parseJsonArray, pipelineKey, type PipelineSpec } from './_shared'

/**
 * Validate Log Pipeline items — static, no network access.
 *   - name (required, <= 255 chars, unique across the canvas).
 *   - processors is required and must parse as a JSON array; each entry must
 *     be an object with a "type" from the 17 documented processor types, and
 *     "is_enabled" (if present) must be a boolean. Type-specific fields
 *     (e.g. a grok-parser's rules) are NOT validated here — see the header
 *     comment in _shared.ts.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Log Pipeline.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPipelineSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors)
    if (spec.name) {
      const key = pipelineKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Duplicate pipeline name "${spec.name}" — each name may only be declared once (pipelines are matched by name).`,
          code: 'DUPLICATE_NAME',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: PipelineSpec, i: number, errors: ValidationError[]): void {
  const prefix = `items[${i}]`

  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Pipeline name is required.', code: 'EMPTY_NAME' })
  } else if (spec.name.length > MAX_NAME_LENGTH) {
    errors.push({ field: `${prefix}.name`, message: `Pipeline name must be ${MAX_NAME_LENGTH} characters or fewer.`, code: 'NAME_TOO_LONG' })
  }

  if (!spec.processorsRaw) {
    errors.push({ field: `${prefix}.processors`, message: 'Processors is required — at least a JSON array ([]).', code: 'EMPTY_PROCESSORS' })
    return
  }

  const parsed = parseJsonArray(spec.processorsRaw)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.processors`, message: 'Processors must be a valid JSON array.', code: 'INVALID_PROCESSORS_JSON' })
    return
  }

  parsed.value?.forEach((p, pi) => {
    if (!isJsonObject(p)) {
      errors.push({ field: `${prefix}.processors[${pi}]`, message: 'Each processor must be a JSON object.', code: 'INVALID_PROCESSOR' })
      return
    }
    if (!PROCESSOR_TYPES.includes(p.type as (typeof PROCESSOR_TYPES)[number])) {
      errors.push({
        field: `${prefix}.processors[${pi}].type`,
        message: `Processor type must be one of ${PROCESSOR_TYPES.join(', ')} (got "${String(p.type)}").`,
        code: 'INVALID_PROCESSOR_TYPE',
      })
    }
    if ('is_enabled' in p && typeof p.is_enabled !== 'boolean') {
      errors.push({
        field: `${prefix}.processors[${pi}].is_enabled`,
        message: 'A processor\'s "is_enabled" must be a boolean.',
        code: 'INVALID_PROCESSOR_ENABLED',
      })
    }
  })
}
