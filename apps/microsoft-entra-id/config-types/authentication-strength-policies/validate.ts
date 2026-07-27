import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra authentication-strength constraints -------------------------------

export const MAX_DISPLAY_NAME_LENGTH = 256
export const MAX_DESCRIPTION_LENGTH = 1024

/** Valid authenticationMethodModes for allowedCombinations (excludes the
 *  evolvable-enum sentinel unknownFutureValue). */
export const AUTH_METHOD_MODES = [
  'password',
  'voice',
  'hardwareOath',
  'softwareOath',
  'sms',
  'fido2',
  'windowsHelloForBusiness',
  'microsoftAuthenticatorPush',
  'deviceBasedPush',
  'temporaryAccessPassOneTime',
  'temporaryAccessPassMultiUse',
  'email',
  'x509CertificateSingleFactor',
  'x509CertificateMultiFactor',
  'federatedSingleFactor',
  'federatedMultiFactor',
] as const

const AUTH_METHOD_MODE_SET = new Set<string>(AUTH_METHOD_MODES)

export interface AuthStrengthSpec {
  itemId?: string
  /** displayName — the logical identity live policies are matched on. */
  name: string
  description: string
  /** Each entry is one allowed combination, its modes joined by ",". */
  combinations: string[]
}

/** An authentication strength policy as returned by Graph. */
export interface LiveAuthStrengthPolicy {
  id?: string
  displayName?: string
  description?: string | null
  policyType?: string
  allowedCombinations?: string[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a combination string into its trimmed, non-empty method modes. */
export function splitModes(combo: string): string[] {
  return combo
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
}

/** Canonical form of a combination for order-insensitive comparison. */
export function normalizeCombo(combo: string): string {
  return splitModes(combo).sort().join(',')
}

/** True when the two combination collections are equal as sets. */
export function combinationsEqual(a: string[], b: string[]): boolean {
  const sa = new Set(a.map(normalizeCombo))
  const sb = new Set(b.map(normalizeCombo))
  if (sa.size !== sb.size) return false
  for (const c of sa) if (!sb.has(c)) return false
  return true
}

/** Only custom (tenant-authored) policies can be modified or deleted. */
export function isCustomPolicy(live: LiveAuthStrengthPolicy): boolean {
  return live.policyType === 'custom'
}

export function extractAuthStrengthSpecs(canvas: CanvasSnapshot): AuthStrengthSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const combinations = asString(f.allowedCombinations)
      .split(/\n/)
      .map((line) => splitModes(line).join(','))
      .filter((c) => c.length > 0)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      combinations,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAuthStrengthSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

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
          message: `Duplicate authentication strength "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'too_long',
      })
    }

    // allowedCombinations — at least one combination; every mode must be valid.
    if (spec.combinations.length === 0) {
      errors.push({
        field: `${prefix}.allowedCombinations`,
        message: 'At least one authentication method combination is required',
        code: 'missing_combinations',
      })
    } else {
      spec.combinations.forEach((combo, c) => {
        splitModes(combo).forEach((mode) => {
          if (!AUTH_METHOD_MODE_SET.has(mode)) {
            errors.push({
              field: `${prefix}.allowedCombinations[${c}]`,
              message: `"${mode}" is not a valid authentication method mode`,
              code: 'invalid_method_mode',
            })
          }
        })
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
