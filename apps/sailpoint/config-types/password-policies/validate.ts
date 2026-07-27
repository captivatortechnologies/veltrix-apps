import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Password Policy constraints -------------------------------

export const MAX_NAME_LENGTH = 128

/** Integer rule fields the app manages. Blank ⇒ 0 (no constraint). */
export const NUMERIC_FIELDS = [
  'minLength',
  'maxLength',
  'minAlpha',
  'minNumeric',
  'minUpper',
  'minLower',
  'minSpecial',
  'minCharacterTypes',
  'maxRepeatedChars',
  'passwordExpiration',
  'firstExpirationReminder',
] as const

/** Boolean rule fields the app manages. Blank ⇒ false. */
export const BOOLEAN_FIELDS = [
  'enablePasswdExpiration',
  'requireStrongAuthn',
  'useDictionary',
  'useIdentityAttributes',
  'useAccountAttributes',
  'validateAgainstAccountId',
  'validateAgainstAccountName',
] as const

export type NumericField = (typeof NUMERIC_FIELDS)[number]
export type BooleanField = (typeof BOOLEAN_FIELDS)[number]

export interface PasswordPolicySpec {
  itemId?: string
  /** name — the logical identity (unique per tenant); the id is stored for rename-safety. */
  name: string
  description: string
  numbers: Record<NumericField, number>
  booleans: Record<BooleanField, boolean>
}

/** A password policy as returned by GET /v3/password-policies (readOnly-inclusive). */
export interface LivePasswordPolicy {
  id?: string
  name?: string
  description?: string | null
  defaultPolicy?: boolean
  [key: string]: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return 0
}

export function extractPasswordPolicySpecs(canvas: CanvasSnapshot): PasswordPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const numbers = {} as Record<NumericField, number>
    for (const key of NUMERIC_FIELDS) numbers[key] = asNumber(f[key])
    const booleans = {} as Record<BooleanField, boolean>
    for (const key of BOOLEAN_FIELDS) booleans[key] = asBool(f[key])
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      numbers,
      booleans,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPasswordPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate password policy "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    for (const key of NUMERIC_FIELDS) {
      const n = spec.numbers[key]
      if (!Number.isInteger(n) || n < 0) {
        errors.push({ field: `${prefix}.${key}`, message: `${key} must be a non-negative whole number`, code: 'invalid_number' })
      }
    }

    // maxLength of 0 means "no maximum"; otherwise it must not be below minLength.
    if (spec.numbers.maxLength > 0 && spec.numbers.minLength > spec.numbers.maxLength) {
      errors.push({ field: `${prefix}.maxLength`, message: 'maxLength must be greater than or equal to minLength', code: 'invalid_range' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
