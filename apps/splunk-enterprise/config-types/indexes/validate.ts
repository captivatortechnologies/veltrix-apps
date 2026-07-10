import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * Validate Splunk Enterprise index configurations.
 *
 * Rules mirror the real Splunk REST API contract for /services/data/indexes
 * and indexes.conf (verified against Splunk Enterprise 9.4/10.x docs):
 *   - Index names: numbers, lowercase letters, underscores and hyphens only;
 *     must not begin with an underscore or hyphen; must not contain "kvstore".
 *   - maxTotalDataSizeMB: non-negative integer (Splunk default 500000).
 *   - frozenTimePeriodInSecs: non-negative integer (Splunk default 188697600 = 6 years).
 *   - maxDataSize (per-bucket): "auto" (750 MB), "auto_high_volume" (10 GB on
 *     64-bit), or an explicit size between 100 and 1048576 MB.
 *   - datatype: "event" or "metric" (settable only at creation).
 *   - thawedPath cannot use volume: references; home/cold paths should.
 */

/** Splunk internal indexes — cannot be created or managed via the canvas. */
const RESERVED_INDEX_NAMES = [
  '_internal', '_audit', '_introspection', '_telemetry',
  '_thefishbucket', '_metrics', '_metrics_rollup', '_configtracker',
]

/** Built-in event indexes that ship with Splunk — managing them is allowed but risky. */
const BUILTIN_INDEX_NAMES = ['main', 'history', 'summary', 'lastchanceindex', 'default']

const INDEX_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
const MAX_INDEX_NAME_LENGTH = 80
const MAX_DATA_SIZE_MB = 10_000_000 // 10TB platform guardrail for maxTotalDataSizeMB
const MAX_FROZEN_DAYS = 36500 // ~100 years
const VALID_DATATYPES = ['event', 'metric']
const VALID_MAX_DATA_SIZE_MODES = ['auto', 'auto_high_volume', 'custom']
const BUCKET_SIZE_MIN_MB = 100
const BUCKET_SIZE_MAX_MB = 1_048_576 // 1 TB — Splunk's documented ceiling for maxDataSize

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const indexNames = new Set<string>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = `${section.name}`

    // --- Index name -------------------------------------------------------
    const name = fields.name as string | undefined
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      errors.push({ field: `${prefix}.name`, message: 'Index name is required', code: 'required' })
    } else {
      if (!INDEX_NAME_PATTERN.test(name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Index names may contain only numbers, lowercase letters, underscores, and hyphens, and cannot begin with an underscore or hyphen',
          code: 'invalid_format',
        })
      }
      if (name.includes('kvstore')) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Index names cannot contain the word "kvstore"',
          code: 'reserved_substring',
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
          message: `"${name}" is a reserved Splunk internal index name`,
          code: 'reserved_name',
        })
      }
      if (BUILTIN_INDEX_NAMES.includes(name)) {
        warnings.push({
          field: `${prefix}.name`,
          message: `"${name}" is a built-in Splunk index — changing its settings affects default ingestion behavior`,
          code: 'builtin_index',
        })
      }
      if (indexNames.has(name)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate index name: "${name}"`, code: 'duplicate' })
      }
      indexNames.add(name)
    }

    // --- datatype (event | metric, create-only in Splunk) ------------------
    const datatype = fields.datatype as string | undefined
    if (datatype !== undefined && !VALID_DATATYPES.includes(datatype)) {
      errors.push({
        field: `${prefix}.datatype`,
        message: `Datatype must be one of: ${VALID_DATATYPES.join(', ')}`,
        code: 'invalid_datatype',
      })
    }

    // --- maxDataSizeMB → maxTotalDataSizeMB --------------------------------
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

    // --- maxDataSizeMode → maxDataSize (per-bucket size) --------------------
    const bucketMode = fields.maxDataSizeMode as string | undefined
    if (bucketMode !== undefined && !VALID_MAX_DATA_SIZE_MODES.includes(bucketMode)) {
      errors.push({
        field: `${prefix}.maxDataSizeMode`,
        message: `Bucket size mode must be one of: ${VALID_MAX_DATA_SIZE_MODES.join(', ')}`,
        code: 'invalid_value',
      })
    }
    const bucketCustom = fields.maxDataSizeCustomMB as number | undefined
    if (bucketMode === 'custom') {
      if (typeof bucketCustom !== 'number' || bucketCustom < BUCKET_SIZE_MIN_MB || bucketCustom > BUCKET_SIZE_MAX_MB) {
        errors.push({
          field: `${prefix}.maxDataSizeCustomMB`,
          message: `Custom bucket size must be between ${BUCKET_SIZE_MIN_MB} and ${BUCKET_SIZE_MAX_MB} MB (Splunk maxDataSize limits)`,
          code: 'range',
        })
      }
    }

    // --- frozenTimeDays → frozenTimePeriodInSecs ----------------------------
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

    // Frozen data is DELETED unless an archive destination is configured.
    const coldToFrozenDir = fields.coldToFrozenDir as string | undefined
    if (frozenDays !== undefined && typeof frozenDays === 'number' && frozenDays > 0 && frozenDays < 30 && !coldToFrozenDir) {
      warnings.push({
        field: `${prefix}.coldToFrozenDir`,
        message: 'Short retention with no frozen archive directory — Splunk permanently deletes frozen buckets by default',
        code: 'no_frozen_archive',
      })
    }

    // --- Storage paths ------------------------------------------------------
    const thawedPath = fields.thawedPath as string | undefined
    if (thawedPath && thawedPath.startsWith('volume:')) {
      errors.push({
        field: `${prefix}.thawedPath`,
        message: 'thawedPath cannot be defined using a volume: reference',
        code: 'invalid_volume_path',
      })
    }
    for (const pathKey of ['homePath', 'coldPath'] as const) {
      const p = fields[pathKey] as string | undefined
      if (p && !p.startsWith('volume:') && !p.includes('$SPLUNK_DB')) {
        warnings.push({
          field: `${prefix}.${pathKey}`,
          message: `${pathKey} does not use a volume: reference or $SPLUNK_DB — hardcoded paths complicate storage management`,
          code: 'nonstandard_path',
        })
      }
    }

    // --- retentionPeriod and searchablePeriod cross-check -------------------
    const retention = fields.retentionPeriod as number | undefined
    const searchable = fields.searchablePeriod as number | undefined
    if (retention && searchable && searchable > retention) {
      warnings.push({
        field: `${prefix}.searchablePeriod`,
        message: 'Searchable period exceeds retention period — some data may not be searchable',
        code: 'retention_mismatch',
      })
    }

    // --- enableCompression recommendation ------------------------------------
    // Splunk always compresses rawdata; this canvas flag selects zstd journal
    // compression (better ratio) versus the gzip default. Recommend it for
    // large indexes.
    const enableCompression = fields.enableCompression as boolean | undefined
    if (enableCompression === false && maxDataSize && maxDataSize > 100_000) {
      warnings.push({
        field: `${prefix}.enableCompression`,
        message: 'Compression is disabled for a large index — consider enabling for storage savings',
        code: 'compression_recommendation',
      })
    }

    // --- TSIDX reduction ------------------------------------------------------
    const tsidxReduction = fields.enableTsidxReduction as boolean | undefined
    const tsidxPeriodDays = fields.tsidxReductionPeriodDays as number | undefined
    if (tsidxReduction === true && tsidxPeriodDays !== undefined) {
      if (typeof tsidxPeriodDays !== 'number' || tsidxPeriodDays <= 0) {
        errors.push({
          field: `${prefix}.tsidxReductionPeriodDays`,
          message: 'TSIDX reduction period must be a positive number of days',
          code: 'invalid_value',
        })
      } else if (tsidxPeriodDays < 7) {
        warnings.push({
          field: `${prefix}.tsidxReductionPeriodDays`,
          message: 'TSIDX reduction within 7 days severely slows searches over recent data',
          code: 'aggressive_tsidx_reduction',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
