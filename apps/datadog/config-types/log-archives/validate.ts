import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { DESTINATION_TYPES, MAX_NAME_LENGTH, archiveKey, extractArchiveSpecs, parseJsonObject, parseOptionalNumber, type ArchiveSpec } from './_shared'

/** Required non-secret key that must be present for each destination `type`, confirmed against the create-archive reference. */
const REQUIRED_KEY_BY_TYPE: Record<string, string> = { s3: 'bucket', gcs: 'bucket', azure: 'container' }

/**
 * Validate Log Archive items — static, no network access.
 *   - name and query are required; name unique across the canvas.
 *   - destination is required and must parse as a JSON object with a
 *     supported "type" (s3/gcs/azure), the type-appropriate required key
 *     (bucket for s3/gcs, container for azure), and an "integration" object.
 *     Per-cloud integration sub-fields are NOT deep-validated — see
 *     _shared.ts for why.
 *   - rehydration_max_scan_size_in_gb, when set, must be a non-negative
 *     number.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Log Archive.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractArchiveSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors)
    if (spec.name) {
      const key = archiveKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Duplicate archive name "${spec.name}" — each name may only be declared once (archives are matched by name).`,
          code: 'DUPLICATE_NAME',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: ArchiveSpec, i: number, errors: ValidationError[]): void {
  const prefix = `items[${i}]`

  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Archive name is required.', code: 'EMPTY_NAME' })
  } else if (spec.name.length > MAX_NAME_LENGTH) {
    errors.push({ field: `${prefix}.name`, message: `Archive name must be ${MAX_NAME_LENGTH} characters or fewer.`, code: 'NAME_TOO_LONG' })
  }

  if (!spec.query) {
    errors.push({ field: `${prefix}.query`, message: 'Query is required.', code: 'EMPTY_QUERY' })
  }

  if (spec.maxScanSizeRaw) {
    const n = parseOptionalNumber(spec.maxScanSizeRaw)
    if (Number.isNaN(n) || (typeof n === 'number' && n < 0)) {
      errors.push({
        field: `${prefix}.rehydration_max_scan_size_in_gb`,
        message: 'Max Rehydration Scan Size must be a non-negative number.',
        code: 'INVALID_MAX_SCAN_SIZE',
      })
    }
  }

  if (!spec.destinationRaw) {
    errors.push({ field: `${prefix}.destination`, message: 'Destination is required.', code: 'EMPTY_DESTINATION' })
    return
  }
  const parsed = parseJsonObject(spec.destinationRaw)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.destination`, message: 'Destination must be a valid JSON object.', code: 'INVALID_DESTINATION_JSON' })
    return
  }
  const dest = parsed.value
  if (!dest) return

  const type = typeof dest.type === 'string' ? dest.type : ''
  if (!DESTINATION_TYPES.includes(type as (typeof DESTINATION_TYPES)[number])) {
    errors.push({
      field: `${prefix}.destination.type`,
      message: `Destination type must be one of ${DESTINATION_TYPES.join(', ')} (got "${type}").`,
      code: 'INVALID_DESTINATION_TYPE',
    })
    return
  }

  const requiredKey = REQUIRED_KEY_BY_TYPE[type]
  if (requiredKey && (typeof dest[requiredKey] !== 'string' || !(dest[requiredKey] as string).trim())) {
    errors.push({
      field: `${prefix}.destination.${requiredKey}`,
      message: `Destination of type "${type}" needs a "${requiredKey}".`,
      code: 'MISSING_DESTINATION_FIELD',
    })
  }

  if (dest.integration === undefined || typeof dest.integration !== 'object' || dest.integration === null || Array.isArray(dest.integration)) {
    errors.push({
      field: `${prefix}.destination.integration`,
      message: 'Destination needs an "integration" object naming the already-configured Datadog cloud integration to use.',
      code: 'MISSING_INTEGRATION',
    })
  }
}
