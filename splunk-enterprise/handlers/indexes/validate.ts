import type { PipelineContext, ValidationResult } from '../../../../core/pipeline-engine/types'

const RESERVED_INDEX_NAMES = [
  '_internal', '_audit', '_introspection', '_telemetry',
  '_thefishbucket', '_metrics', '_metrics_rollup',
]

const MAX_INDEX_NAME_LENGTH = 80
const MAX_DATA_SIZE_MB = 10_000_000 // 10TB
const MAX_FROZEN_DAYS = 36500 // ~100 years

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = `${section.name}`

    // Index name validation
    const name = fields.name as string | undefined
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      errors.push({ field: `${prefix}.name`, message: 'Index name is required', code: 'required' })
    } else {
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Index name must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores',
          code: 'invalid_format',
        })
      }
      if (name.length > MAX_INDEX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Index name must be ${MAX_INDEX_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (RESERVED_INDEX_NAMES.includes(name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `"${name}" is a reserved Splunk index name`,
          code: 'reserved_name',
        })
      }
    }

    // maxDataSizeMB validation
    const maxDataSize = fields.maxDataSizeMB as number | undefined
    if (maxDataSize !== undefined) {
      if (typeof maxDataSize !== 'number' || maxDataSize <= 0) {
        errors.push({ field: `${prefix}.maxDataSizeMB`, message: 'Max data size must be a positive number', code: 'invalid_value' })
      } else if (maxDataSize > MAX_DATA_SIZE_MB) {
        errors.push({ field: `${prefix}.maxDataSizeMB`, message: `Max data size cannot exceed ${MAX_DATA_SIZE_MB} MB`, code: 'range' })
      } else if (maxDataSize > 1_000_000) {
        warnings.push({ field: `${prefix}.maxDataSizeMB`, message: 'Max data size exceeds 1TB — ensure sufficient storage capacity', code: 'large_value' })
      }
    }

    // frozenTimeDays validation
    const frozenDays = fields.frozenTimeDays as number | undefined
    if (frozenDays !== undefined) {
      if (typeof frozenDays !== 'number' || frozenDays <= 0) {
        errors.push({ field: `${prefix}.frozenTimeDays`, message: 'Frozen time must be a positive number of days', code: 'invalid_value' })
      } else if (frozenDays > MAX_FROZEN_DAYS) {
        errors.push({ field: `${prefix}.frozenTimeDays`, message: `Frozen time cannot exceed ${MAX_FROZEN_DAYS} days`, code: 'range' })
      } else if (frozenDays < 7) {
        warnings.push({ field: `${prefix}.frozenTimeDays`, message: 'Frozen time is very short — data will be archived quickly', code: 'short_retention' })
      }
    }

    // retentionPeriod and searchablePeriod cross-check
    const retention = fields.retentionPeriod as number | undefined
    const searchable = fields.searchablePeriod as number | undefined
    if (retention && searchable && searchable > retention) {
      warnings.push({
        field: `${prefix}.searchablePeriod`,
        message: 'Searchable period exceeds retention period — some data may not be searchable',
        code: 'retention_mismatch',
      })
    }

    // enableCompression recommendation
    const enableCompression = fields.enableCompression as boolean | undefined
    if (enableCompression === false && maxDataSize && maxDataSize > 100_000) {
      warnings.push({
        field: `${prefix}.enableCompression`,
        message: 'Compression is disabled for a large index — consider enabling for storage savings',
        code: 'compression_recommendation',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
