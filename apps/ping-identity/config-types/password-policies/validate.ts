import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- PingOne Password Policies API constraints -------------------------------
// https://apidocs.pingidentity.com/pingone/platform/v1/api/#password-policies

/** A policy name is capped at 256 characters and must be unique in the environment. */
export const MAX_NAME_LENGTH = 256

/** Password length bounds PingOne enforces on `length.min`. */
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 32

/**
 * PingOne currently only accepts these fixed values for these three settings -
 * any other value is rejected by the API. minComplexity/minUniqueCharacters/
 * maxRepeatedCharacters are otherwise absent (feature disabled) when unset.
 */
export const REQUIRED_MIN_COMPLEXITY = 7
export const REQUIRED_MIN_UNIQUE_CHARACTERS = 5
export const REQUIRED_MAX_REPEATED_CHARACTERS = 2

/** maxAgeDays must exceed (minAgeDays || 0) plus this many days. */
export const MAX_AGE_MIN_AGE_BUFFER_DAYS = 21

/** The only two "run length" values alphabetSequenceRule/numberSequenceRule accept. */
export const SEQUENCE_MAX_LENGTHS = [2, 3] as const

/**
 * Literal PingOne `minCharacters` map keys - each IS the character class
 * itself, not a symbolic name. Modeled in the canvas as four separate
 * counters (minCharUppercase/Lowercase/Numeric/Special); deploy.ts assembles
 * this exact map from those counters.
 */
export const MIN_CHAR_UPPERCASE_KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const MIN_CHAR_LOWERCASE_KEY = 'abcdefghijklmnopqrstuvwxyz'
export const MIN_CHAR_NUMERIC_KEY = '0123456789'
export const MIN_CHAR_SPECIAL_KEY = '~!@#$%^&*()-_=+[]{}\\|;:,.<>/?'

// --- Spec extraction shared by deploy / rollback / driftDetect / healthCheck -

export interface PasswordPolicySpec {
  sectionName: string
  name: string
  description?: string
  default?: boolean
  excludesCommonlyUsedPasswords: boolean
  excludesProfileData: boolean
  notSimilarToCurrent: boolean
  minLength?: number
  maxLength?: number
  historyCount?: number
  historyRetentionDays?: number
  maxAgeDays?: number
  minAgeDays?: number
  lockoutFailureCount?: number
  lockoutDurationSeconds?: number
  minCharUppercase?: number
  minCharLowercase?: number
  minCharNumeric?: number
  minCharSpecial?: number
  minComplexity?: number
  minUniqueCharacters?: number
  maxRepeatedCharacters?: number
  alphabetSequenceMaxLength?: number
  numberSequenceMaxLength?: number
}

/**
 * Shape of a password policy returned by GET /passwordPolicies. Carries an
 * index signature so server-managed fields (environment, createdAt,
 * updatedAt, _links, populationCount) survive a round-trip without a rigid
 * type, and so live values can be read defensively.
 */
export interface LivePasswordPolicy {
  id?: string
  name?: string
  description?: string
  default?: boolean
  excludesCommonlyUsedPasswords?: boolean
  excludesProfileData?: boolean
  notSimilarToCurrent?: boolean
  history?: { count?: number; retentionDays?: number }
  length?: { min?: number; max?: number }
  lockout?: { failureCount?: number; durationSeconds?: number }
  maxAgeDays?: number
  minAgeDays?: number
  minCharacters?: Record<string, number>
  minComplexity?: number
  minUniqueCharacters?: number
  maxRepeatedCharacters?: number
  alphabetSequenceRule?: { maxLength?: number }
  numberSequenceRule?: { maxLength?: number }
  qwertySequenceRule?: { maxLength?: number }
  shiftedNumberRowSequenceRule?: { maxLength?: number }
  populationCount?: number
  environment?: unknown
  createdAt?: string
  updatedAt?: string
  _links?: unknown
  [key: string]: unknown
}

/** Read a field as a finite number, tolerating a numeric string from form input. */
function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 'true'
}

/** Each canvas item describes one PingOne password policy. */
export function extractPasswordPolicySpecs(canvas: CanvasSnapshot): PasswordPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' && fields.description.trim() ? fields.description.trim() : undefined,
      default: fields.default === undefined ? undefined : toBoolean(fields.default),
      excludesCommonlyUsedPasswords: toBoolean(fields.excludesCommonlyUsedPasswords),
      excludesProfileData: toBoolean(fields.excludesProfileData),
      notSimilarToCurrent: toBoolean(fields.notSimilarToCurrent),
      minLength: toOptionalNumber(fields.minLength),
      maxLength: toOptionalNumber(fields.maxLength),
      historyCount: toOptionalNumber(fields.historyCount),
      historyRetentionDays: toOptionalNumber(fields.historyRetentionDays),
      maxAgeDays: toOptionalNumber(fields.maxAgeDays),
      minAgeDays: toOptionalNumber(fields.minAgeDays),
      lockoutFailureCount: toOptionalNumber(fields.lockoutFailureCount),
      lockoutDurationSeconds: toOptionalNumber(fields.lockoutDurationSeconds),
      minCharUppercase: toOptionalNumber(fields.minCharUppercase),
      minCharLowercase: toOptionalNumber(fields.minCharLowercase),
      minCharNumeric: toOptionalNumber(fields.minCharNumeric),
      minCharSpecial: toOptionalNumber(fields.minCharSpecial),
      minComplexity: toOptionalNumber(fields.minComplexity),
      minUniqueCharacters: toOptionalNumber(fields.minUniqueCharacters),
      maxRepeatedCharacters: toOptionalNumber(fields.maxRepeatedCharacters),
      alphabetSequenceMaxLength: toOptionalNumber(fields.alphabetSequenceMaxLength),
      numberSequenceMaxLength: toOptionalNumber(fields.numberSequenceMaxLength),
    }
  })
}

/** True when a value is set and is not a non-negative integer. */
function isInvalidNonNegativeInteger(value: number | undefined): boolean {
  return value !== undefined && (!Number.isInteger(value) || value < 0)
}

// --- Validate handler ----------------------------------------------------------

/**
 * Validate password-policy configurations against the PingOne Platform API.
 * Static only - it never contacts PingOne:
 *   - name is required, <= 256 chars, and unique within the canvas (PingOne
 *     matches policies by exact, case-sensitive name)
 *   - minLength is required and within 8-32; maxLength (when set) is >= minLength
 *   - minComplexity, when set, must equal 7 (the only value PingOne accepts)
 *   - minUniqueCharacters, when set, must equal 5
 *   - maxRepeatedCharacters, when set, must equal 2
 *   - when maxAgeDays is set, it must be greater than (minAgeDays || 0) + 21 -
 *     PingOne's own API rule, so this applies even when minAgeDays is unset
 *   - lockoutFailureCount / lockoutDurationSeconds must both be set or both blank
 *   - historyCount / historyRetentionDays must both be set or both blank
 *   - alphabetSequenceMaxLength / numberSequenceMaxLength, when set, must be 2 or 3
 *   - every numeric field, when set, is a non-negative integer
 * A warning (not an error) flags more than one policy marked as the environment
 * default - PingOne silently demotes every other policy's default flag, so the
 * last one deployed wins.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPasswordPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()
  let defaultCount = 0

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name - required, <= 256 chars, unique (case-sensitive - PingOne matches exact)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Policy name must be ${MAX_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" - each policy may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(spec.name)
    }

    if (spec.default) defaultCount += 1

    // minLength - required, 8-32
    if (spec.minLength === undefined) {
      errors.push({ field: `${prefix}.minLength`, message: 'Minimum length is required', code: 'required' })
    } else if (spec.minLength < MIN_PASSWORD_LENGTH || spec.minLength > MAX_PASSWORD_LENGTH) {
      errors.push({
        field: `${prefix}.minLength`,
        message: `Minimum length must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH}`,
        code: 'invalid_range',
      })
    }

    // maxLength - when set, must not be below minLength
    if (spec.maxLength !== undefined && spec.minLength !== undefined && spec.maxLength < spec.minLength) {
      errors.push({
        field: `${prefix}.maxLength`,
        message: 'Maximum length cannot be less than the minimum length',
        code: 'max_length_below_min',
      })
    }

    // minComplexity / minUniqueCharacters / maxRepeatedCharacters - fixed values
    if (spec.minComplexity !== undefined && spec.minComplexity !== REQUIRED_MIN_COMPLEXITY) {
      errors.push({
        field: `${prefix}.minComplexity`,
        message: `PingOne only accepts ${REQUIRED_MIN_COMPLEXITY} for minimum complexity score`,
        code: 'invalid_min_complexity',
      })
    }
    if (spec.minUniqueCharacters !== undefined && spec.minUniqueCharacters !== REQUIRED_MIN_UNIQUE_CHARACTERS) {
      errors.push({
        field: `${prefix}.minUniqueCharacters`,
        message: `PingOne only accepts ${REQUIRED_MIN_UNIQUE_CHARACTERS} for minimum unique characters`,
        code: 'invalid_min_unique_characters',
      })
    }
    if (
      spec.maxRepeatedCharacters !== undefined &&
      spec.maxRepeatedCharacters !== REQUIRED_MAX_REPEATED_CHARACTERS
    ) {
      errors.push({
        field: `${prefix}.maxRepeatedCharacters`,
        message: `PingOne only accepts ${REQUIRED_MAX_REPEATED_CHARACTERS} for maximum repeated characters`,
        code: 'invalid_max_repeated_characters',
      })
    }

    // maxAgeDays - must exceed (minAgeDays || 0) + 21 whenever it is set
    if (spec.maxAgeDays !== undefined) {
      const minimumRequired = (spec.minAgeDays ?? 0) + MAX_AGE_MIN_AGE_BUFFER_DAYS
      if (spec.maxAgeDays <= minimumRequired) {
        errors.push({
          field: `${prefix}.maxAgeDays`,
          message: `Maximum password age must be greater than ${minimumRequired} days (minimum age + ${MAX_AGE_MIN_AGE_BUFFER_DAYS})`,
          code: 'invalid_max_age_days',
        })
      }
    }

    // lockoutFailureCount / lockoutDurationSeconds - paired
    const lockoutFailureSet = spec.lockoutFailureCount !== undefined
    const lockoutDurationSet = spec.lockoutDurationSeconds !== undefined
    if (lockoutFailureSet !== lockoutDurationSet) {
      errors.push({
        field: `${prefix}.lockoutFailureCount`,
        message: 'Lockout failure count and lockout duration must both be set, or both left blank',
        code: 'lockout_pairing',
      })
    }

    // historyCount / historyRetentionDays - paired
    const historyCountSet = spec.historyCount !== undefined
    const historyRetentionSet = spec.historyRetentionDays !== undefined
    if (historyCountSet !== historyRetentionSet) {
      errors.push({
        field: `${prefix}.historyCount`,
        message: 'History count and history retention days must both be set, or both left blank',
        code: 'history_pairing',
      })
    }

    // alphabetSequenceMaxLength / numberSequenceMaxLength - 2 or 3 only
    if (
      spec.alphabetSequenceMaxLength !== undefined &&
      !(SEQUENCE_MAX_LENGTHS as readonly number[]).includes(spec.alphabetSequenceMaxLength)
    ) {
      errors.push({
        field: `${prefix}.alphabetSequenceMaxLength`,
        message: `Alphabet sequence max length must be one of: ${SEQUENCE_MAX_LENGTHS.join(', ')}`,
        code: 'invalid_alphabet_sequence_max_length',
      })
    }
    if (
      spec.numberSequenceMaxLength !== undefined &&
      !(SEQUENCE_MAX_LENGTHS as readonly number[]).includes(spec.numberSequenceMaxLength)
    ) {
      errors.push({
        field: `${prefix}.numberSequenceMaxLength`,
        message: `Number sequence max length must be one of: ${SEQUENCE_MAX_LENGTHS.join(', ')}`,
        code: 'invalid_number_sequence_max_length',
      })
    }

    // Every remaining numeric field, when set, must be a non-negative integer.
    const nonNegativeFields: Array<[string, number | undefined]> = [
      ['historyCount', spec.historyCount],
      ['historyRetentionDays', spec.historyRetentionDays],
      ['maxAgeDays', spec.maxAgeDays],
      ['minAgeDays', spec.minAgeDays],
      ['lockoutFailureCount', spec.lockoutFailureCount],
      ['lockoutDurationSeconds', spec.lockoutDurationSeconds],
      ['minCharUppercase', spec.minCharUppercase],
      ['minCharLowercase', spec.minCharLowercase],
      ['minCharNumeric', spec.minCharNumeric],
      ['minCharSpecial', spec.minCharSpecial],
    ]
    for (const [key, value] of nonNegativeFields) {
      if (isInvalidNonNegativeInteger(value)) {
        errors.push({
          field: `${prefix}.${key}`,
          message: `${key} must be a non-negative whole number`,
          code: 'invalid_number',
        })
      }
    }
  }

  if (defaultCount > 1) {
    warnings.push({
      field: 'default',
      message: `${defaultCount} policies are marked as the default - PingOne only allows one; the last one deployed will silently demote the others`,
      code: 'multiple_defaults',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
