import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ACS index constraints (see README for documentation sources) -----------

/** Splunk Cloud index names: lowercase letters, numbers, underscores, hyphens; must begin with a lowercase letter or number. */
export const INDEX_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
export const MAX_INDEX_NAME_LENGTH = 80
/** ACS maxDataArchiveRetentionPeriod — DDAA archival retention cannot exceed 10 years. */
export const MAX_ARCHIVAL_RETENTION_DAYS = 3650
/** ACS default when searchableDays is omitted at creation. */
export const DEFAULT_SEARCHABLE_DAYS = 90
/** DDSS bucket paths must target AWS S3 or GCP GCS. */
export const SELF_STORAGE_PATH_RE = /^(s3|gs):\/\/.+/
const LARGE_INDEX_WARNING_MB = 1_000_000
const LONG_RETENTION_WARNING_DAYS = 3650

// --- Spec extraction shared by deploy / rollback / healthCheck / drift ------

export interface IndexSpec {
  sectionName: string
  name: string
  datatype: 'event' | 'metric'
  searchableDays?: number
  maxDataSizeMB?: number
  splunkArchivalRetentionDays?: number
  selfStorageBucketPath?: string
}

/** Shape of an index entry returned by GET /adminconfig/v2/indexes/{name}. */
export interface LiveIndex {
  name?: string
  datatype?: string
  searchableDays?: number
  maxDataSizeMB?: number
  splunkArchivalRetentionDays?: number
  selfStorageBucketPath?: string
  totalEventCount?: string
  totalRawSizeMB?: string
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

/** Each canvas section describes one Splunk Cloud index. */
export function extractIndexSpecs(canvas: CanvasSnapshot): IndexSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const bucketPath =
      typeof fields.selfStorageBucketPath === 'string' && fields.selfStorageBucketPath.trim()
        ? fields.selfStorageBucketPath.trim()
        : undefined
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      datatype: fields.datatype === 'metric' ? 'metric' : 'event',
      searchableDays: toNumber(fields.searchableDays),
      maxDataSizeMB: toNumber(fields.maxDataSizeMB),
      splunkArchivalRetentionDays: toNumber(fields.splunkArchivalRetentionDays),
      selfStorageBucketPath: bucketPath,
    }
  })
}

// --- Validate handler --------------------------------------------------------

/**
 * Validate Splunk Cloud index configurations against ACS constraints:
 * naming rules, searchable retention, size caps, and DDAA/DDSS archival
 * settings (mutually exclusive; archival must exceed searchable retention).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
  const seenNames = new Set<string>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = section.name

    // Index name
    const name = fields.name as string | undefined
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      errors.push({ field: `${prefix}.name`, message: 'Index name is required', code: 'required' })
    } else {
      const trimmed = name.trim()
      if (!INDEX_NAME_RE.test(trimmed)) {
        errors.push({
          field: `${prefix}.name`,
          message:
            'Index name must begin with a lowercase letter or number and contain only lowercase letters, numbers, underscores, and hyphens. Internal indexes (leading underscore) cannot be managed via ACS.',
          code: 'invalid_format',
        })
      }
      if (trimmed.length > MAX_INDEX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Index name must be ${MAX_INDEX_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (seenNames.has(trimmed)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate index "${trimmed}" — each index may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(trimmed)
    }

    // datatype (event | metric) — immutable after creation via ACS
    const datatype = fields.datatype
    if (datatype !== undefined && datatype !== 'event' && datatype !== 'metric') {
      errors.push({
        field: `${prefix}.datatype`,
        message: 'Datatype must be "event" or "metric"',
        code: 'invalid_datatype',
      })
    }

    // searchableDays
    const searchableDays = fields.searchableDays as number | undefined
    if (searchableDays !== undefined) {
      if (!isInt(searchableDays) || searchableDays <= 0) {
        errors.push({
          field: `${prefix}.searchableDays`,
          message: 'Searchable days must be a positive integer',
          code: 'invalid_value',
        })
      } else if (searchableDays > LONG_RETENTION_WARNING_DAYS) {
        warnings.push({
          field: `${prefix}.searchableDays`,
          message: `Searchable retention over ${LONG_RETENTION_WARNING_DAYS} days — verify your Splunk Cloud entitlement supports it`,
          code: 'long_retention',
        })
      }
    }

    // maxDataSizeMB (0 = unlimited)
    const maxDataSizeMB = fields.maxDataSizeMB as number | undefined
    if (maxDataSizeMB !== undefined) {
      if (!isInt(maxDataSizeMB) || maxDataSizeMB < 0) {
        errors.push({
          field: `${prefix}.maxDataSizeMB`,
          message: 'Max data size must be a non-negative integer (0 = unlimited)',
          code: 'invalid_value',
        })
      } else if (maxDataSizeMB > LARGE_INDEX_WARNING_MB) {
        warnings.push({
          field: `${prefix}.maxDataSizeMB`,
          message: 'Max data size exceeds 1 TB — confirm your ingestion entitlement covers this index',
          code: 'large_value',
        })
      }
    }

    // splunkArchivalRetentionDays (DDAA)
    const archivalDays = fields.splunkArchivalRetentionDays as number | undefined
    if (archivalDays !== undefined) {
      if (!isInt(archivalDays) || archivalDays < 0) {
        errors.push({
          field: `${prefix}.splunkArchivalRetentionDays`,
          message: 'Archival retention must be a non-negative integer number of days',
          code: 'invalid_value',
        })
      } else if (archivalDays > 0) {
        if (archivalDays > MAX_ARCHIVAL_RETENTION_DAYS) {
          errors.push({
            field: `${prefix}.splunkArchivalRetentionDays`,
            message: `Archival retention cannot exceed ${MAX_ARCHIVAL_RETENTION_DAYS} days (ACS maxDataArchiveRetentionPeriod)`,
            code: 'range',
          })
        }
        const effectiveSearchable = isInt(searchableDays) && searchableDays > 0 ? searchableDays : DEFAULT_SEARCHABLE_DAYS
        if (archivalDays <= effectiveSearchable) {
          errors.push({
            field: `${prefix}.splunkArchivalRetentionDays`,
            message: `Archival retention (${archivalDays}) must be greater than searchable days (${effectiveSearchable})`,
            code: 'archival_conflict',
          })
        }
      }
    }

    // selfStorageBucketPath (DDSS)
    const bucketPath = fields.selfStorageBucketPath as string | undefined
    if (bucketPath !== undefined && bucketPath !== null && String(bucketPath).trim() !== '') {
      if (typeof bucketPath !== 'string' || !SELF_STORAGE_PATH_RE.test(bucketPath.trim())) {
        errors.push({
          field: `${prefix}.selfStorageBucketPath`,
          message: 'Self storage bucket path must start with s3:// (AWS) or gs:// (GCP)',
          code: 'invalid_format',
        })
      }
      // DDAA and DDSS are mutually exclusive per index
      if (isInt(archivalDays) && archivalDays > 0) {
        errors.push({
          field: `${prefix}.selfStorageBucketPath`,
          message:
            'An index cannot use both DDAA (splunkArchivalRetentionDays) and DDSS (selfStorageBucketPath) — choose one archival strategy',
          code: 'storage_conflict',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
