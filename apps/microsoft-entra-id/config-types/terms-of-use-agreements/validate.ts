import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra terms-of-use-agreement constraints --------------------------------
//
// An agreement is identified by its displayName. Graph REQUIRES a base64 PDF to
// create one, so fileData is required. The schedule fields (re-accept frequency
// and expiration) are ISO 8601 durations / date-times validated only when set.

export const MAX_DISPLAY_NAME_LENGTH = 256
export const MAX_FILE_NAME_LENGTH = 256

/** ISO 8601 duration, e.g. P365D, P1Y, PT8H. Requires at least one component. */
export const ISO8601_DURATION_RE =
  /^P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/
/** ISO 8601 date-time, e.g. 2026-01-01T00:00:00Z or with an offset. */
export const ISO8601_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/
/** base64 alphabet (whitespace tolerated so pasted PDFs with line breaks pass). */
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

export interface TermsExpiration {
  startDateTime?: string | null
  frequency?: string | null
}

export interface TermsOfUseSpec {
  itemId?: string
  /** displayName — the logical identity live agreements are matched on. */
  name: string
  viewingBeforeAcceptanceRequired: boolean
  perDeviceAcceptanceRequired: boolean
  /** userReacceptRequiredFrequency ISO 8601 duration, or '' for none. */
  reacceptFrequency: string
  /** termsExpiration.startDateTime ISO 8601 date-time, or ''. */
  expirationStartDate: string
  /** termsExpiration.frequency ISO 8601 duration, or ''. */
  expirationFrequency: string
  fileName: string
  fileLanguage: string
  /** base64 PDF bytes. Required to create; not compared for drift. */
  fileData: string
}

/** An agreement as returned by Graph GET /identityGovernance/termsOfUse/agreements. */
export interface LiveTermsOfUse {
  id?: string
  displayName?: string
  isViewingBeforeAcceptanceRequired?: boolean
  isPerDeviceAcceptanceRequired?: boolean
  userReacceptRequiredFrequency?: string | null
  termsExpiration?: TermsExpiration | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractTermsOfUseSpecs(canvas: CanvasSnapshot): TermsOfUseSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      viewingBeforeAcceptanceRequired: asBool(f.viewingBeforeAcceptanceRequired),
      perDeviceAcceptanceRequired: asBool(f.perDeviceAcceptanceRequired),
      reacceptFrequency: asString(f.reacceptFrequency),
      expirationStartDate: asString(f.expirationStartDate),
      expirationFrequency: asString(f.expirationFrequency),
      fileName: asString(f.fileName),
      fileLanguage: asString(f.fileLanguage),
      fileData: asString(f.fileData),
    }
  })
}

/** The effective PDF file name for a spec (explicit value, else the default). */
export function effectiveFileName(spec: TermsOfUseSpec): string {
  return spec.fileName || 'agreement.pdf'
}

/** The effective PDF language for a spec (explicit value, else the default). */
export function effectiveLanguage(spec: TermsOfUseSpec): string {
  return spec.fileLanguage || 'en'
}

/** The termsExpiration object for a spec, or undefined when not both parts are set. */
export function buildTermsExpiration(spec: TermsOfUseSpec): TermsExpiration | undefined {
  if (spec.expirationStartDate && spec.expirationFrequency) {
    return { startDateTime: spec.expirationStartDate, frequency: spec.expirationFrequency }
  }
  return undefined
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTermsOfUseSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    // displayName — required, length, uniqueness
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate agreement "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // fileData — Graph requires a base64 PDF to create an agreement.
    if (!spec.fileData) {
      errors.push({
        field: `${prefix}.fileData`,
        message: 'PDF content (base64) is required — Graph needs a file to create the agreement',
        code: 'file_required',
      })
    } else if (!BASE64_RE.test(spec.fileData)) {
      errors.push({
        field: `${prefix}.fileData`,
        message: 'PDF content must be base64-encoded',
        code: 'invalid_file_data',
      })
    }

    if (spec.fileName && spec.fileName.length > MAX_FILE_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.fileName`,
        message: `File name must be ${MAX_FILE_NAME_LENGTH} characters or fewer`,
        code: 'too_long',
      })
    }

    // re-accept frequency — ISO 8601 duration when provided.
    if (spec.reacceptFrequency && !ISO8601_DURATION_RE.test(spec.reacceptFrequency)) {
      errors.push({
        field: `${prefix}.reacceptFrequency`,
        message: 'Re-accept frequency must be an ISO 8601 duration (e.g. P365D)',
        code: 'invalid_duration',
      })
    }

    // termsExpiration — start and frequency are a pair; each is validated by type.
    if (spec.expirationStartDate && !ISO8601_DATETIME_RE.test(spec.expirationStartDate)) {
      errors.push({
        field: `${prefix}.expirationStartDate`,
        message: 'Expiration start must be an ISO 8601 date-time (e.g. 2026-01-01T00:00:00Z)',
        code: 'invalid_datetime',
      })
    }
    if (spec.expirationFrequency && !ISO8601_DURATION_RE.test(spec.expirationFrequency)) {
      errors.push({
        field: `${prefix}.expirationFrequency`,
        message: 'Expiration frequency must be an ISO 8601 duration (e.g. P365D)',
        code: 'invalid_duration',
      })
    }
    if (Boolean(spec.expirationStartDate) !== Boolean(spec.expirationFrequency)) {
      errors.push({
        field: `${prefix}.expirationFrequency`,
        message: 'Expiration needs both a start date and a frequency, or neither',
        code: 'incomplete_expiration',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
