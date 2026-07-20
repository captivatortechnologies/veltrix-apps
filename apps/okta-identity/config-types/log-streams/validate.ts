import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Log Streaming API constraints --------------------------------------
//
// A log stream exports System Log events to AWS EventBridge or Splunk Cloud. Its
// logical identity is its NAME. Endpoints:
//   GET/POST      /logStreams                          — list / create
//   GET/PUT/DEL   /logStreams/{id}                     — get / replace / delete
//   POST          /logStreams/{id}/lifecycle/activate  — status → ACTIVE
//   POST          /logStreams/{id}/lifecycle/deactivate— status → INACTIVE
// `type` and the whole `settings` block are WRITE-ONCE (immutable after create).
// The Splunk `token` is WRITE-ONLY (create-only; never returned). `status` is
// read-only in the body — driven by the lifecycle endpoints.

/** The two log-stream destination types. */
export const LOG_STREAM_TYPES = ['aws_eventbridge', 'splunk_cloud_logstreaming'] as const
export type LogStreamType = (typeof LOG_STREAM_TYPES)[number]

/** A stream's lifecycle state — changed via the lifecycle endpoints, not PUT. */
export const LOG_STREAM_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** Log-stream name cap. */
export const MAX_LOG_STREAM_NAME_LENGTH = 255

/** AWS regions Okta EventBridge log streaming supports. */
export const AWS_REGIONS = [
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1',
  'ap-southeast-1', 'ap-southeast-2', 'ca-central-1', 'eu-central-1',
  'eu-north-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'sa-east-1',
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
] as const

/** Splunk Cloud editions. */
export const SPLUNK_EDITIONS = ['aws', 'aws_govcloud', 'gcp'] as const

/** A 12-digit AWS account id. */
const AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface LogStreamSpec {
  sectionName: string
  /** Stream name — the logical identity deploy matches on. */
  name: string
  /** Destination type — aws_eventbridge | splunk_cloud_logstreaming (immutable). */
  type: string
  /** Desired lifecycle status — ACTIVE | INACTIVE. */
  status: string
  /** Raw JSON string of the (non-secret) destination settings. */
  settingsJson?: string
  /** WRITE-ONLY Splunk HEC token — used at create only; never drift-checked. */
  splunkToken?: string
}

/** Shape of a log stream returned by GET /logStreams. */
export interface LiveLogStream {
  id?: string
  name?: string
  type?: string
  status?: string
  settings?: Record<string, unknown>
  created?: string
  lastUpdated?: string
  _links?: unknown
  [key: string]: unknown
}

/**
 * Parse a raw JSON string, returning the object or null when the string is not a
 * JSON object (a JSON array or primitive counts as invalid too).
 */
export function parseConfigObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

/**
 * Preserve a secret's EXACT characters (a token may contain punctuation), but
 * treat a whitespace-only value as blank (undefined).
 */
export function preserveSecret(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim().length > 0 ? value : undefined
}

/** Each canvas item describes one Okta log stream. */
export function extractLogStreamSpecs(canvas: CanvasSnapshot): LogStreamSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const settingsJson =
      typeof fields.settingsJson === 'string' && fields.settingsJson.trim()
        ? fields.settingsJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      // type is a lower-case enum; normalise so a mixed-case entry still matches.
      type: typeof fields.type === 'string' ? fields.type.trim().toLowerCase() : '',
      status:
        typeof fields.status === 'string' && fields.status.trim()
          ? fields.status.trim().toUpperCase()
          : 'ACTIVE',
      settingsJson,
      splunkToken: preserveSecret(fields.splunkToken),
    }
  })
}

/** True for the Splunk destination type. */
export function isSplunk(type: string): boolean {
  return type === 'splunk_cloud_logstreaming'
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate log-stream configurations against the Okta Log Streaming API. Static
 * only — it never contacts Okta:
 *   - name is required, <= 255 chars, unique within the canvas
 *   - type is one of aws_eventbridge | splunk_cloud_logstreaming
 *   - status (when set) is ACTIVE | INACTIVE
 *   - settingsJson is required and parses to a JSON OBJECT
 *   - per-type: AWS needs accountId (12 digits) / eventSourceName / region (valid);
 *     Splunk needs host / edition (valid); the HEC token belongs in the separate
 *     field and is required only when first creating a Splunk stream (a WARNING —
 *     the token is immutable so it is ignored on update)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractLogStreamSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Log stream name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_LOG_STREAM_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Log stream name must be ${MAX_LOG_STREAM_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate log stream "${spec.name}" — each stream may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // type — required and in the enum
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Destination type is required', code: 'required' })
    } else if (!(LOG_STREAM_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Destination type must be one of: ${LOG_STREAM_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // status — when set, must be ACTIVE or INACTIVE
    if (spec.status && !(LOG_STREAM_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${LOG_STREAM_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    // settings — required, a JSON object; then per-type checks
    const settings = spec.settingsJson ? parseConfigObject(spec.settingsJson) : null
    if (!spec.settingsJson) {
      errors.push({ field: `${prefix}.settingsJson`, message: 'Settings (JSON) is required', code: 'required' })
    } else if (settings === null) {
      errors.push({
        field: `${prefix}.settingsJson`,
        message: 'Settings must be a valid JSON object',
        code: 'invalid_settings',
      })
    } else if ((LOG_STREAM_TYPES as readonly string[]).includes(spec.type)) {
      checkSettings(spec, settings, prefix, errors, warnings)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Per-type settings sanity checks. Shallow — Okta owns the authoritative schema. */
function checkSettings(
  spec: LogStreamSpec,
  settings: Record<string, unknown>,
  prefix: string,
  errors: ValidationResult['errors'],
  warnings: ValidationResult['warnings'],
): void {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

  if (isSplunk(spec.type)) {
    if (!str(settings.host)) {
      errors.push({ field: `${prefix}.settingsJson`, message: 'Splunk settings need a "host"', code: 'missing_setting' })
    }
    const edition = str(settings.edition)
    if (!edition) {
      errors.push({ field: `${prefix}.settingsJson`, message: 'Splunk settings need an "edition"', code: 'missing_setting' })
    } else if (!(SPLUNK_EDITIONS as readonly string[]).includes(edition)) {
      errors.push({
        field: `${prefix}.settingsJson`,
        message: `Splunk "edition" must be one of: ${SPLUNK_EDITIONS.join(', ')}`,
        code: 'invalid_setting',
      })
    }
    if ('token' in settings) {
      warnings.push({
        field: `${prefix}.settingsJson`,
        message: 'Put the Splunk HEC token in the "Splunk HEC Token" field, not the settings JSON — it is a write-only secret',
        code: 'token_in_settings',
      })
    }
    if (!spec.splunkToken) {
      warnings.push({
        field: `${prefix}.splunkToken`,
        message: 'Splunk HEC token is required when first creating this stream — the token is immutable, so it is ignored on update',
        code: 'missing_token',
      })
    }
  } else {
    // AWS EventBridge
    const accountId = str(settings.accountId)
    if (!accountId) {
      errors.push({ field: `${prefix}.settingsJson`, message: 'AWS settings need an "accountId"', code: 'missing_setting' })
    } else if (!AWS_ACCOUNT_ID_PATTERN.test(accountId)) {
      errors.push({
        field: `${prefix}.settingsJson`,
        message: 'AWS "accountId" must be a 12-digit AWS account id',
        code: 'invalid_setting',
      })
    }
    if (!str(settings.eventSourceName)) {
      errors.push({ field: `${prefix}.settingsJson`, message: 'AWS settings need an "eventSourceName"', code: 'missing_setting' })
    }
    const region = str(settings.region)
    if (!region) {
      errors.push({ field: `${prefix}.settingsJson`, message: 'AWS settings need a "region"', code: 'missing_setting' })
    } else if (!(AWS_REGIONS as readonly string[]).includes(region)) {
      errors.push({
        field: `${prefix}.settingsJson`,
        message: `AWS "region" must be one of the supported EventBridge regions (e.g. us-east-1)`,
        code: 'invalid_setting',
      })
    }
  }
}
