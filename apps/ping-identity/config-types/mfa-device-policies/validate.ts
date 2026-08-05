import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// PingOne MFA Device Authentication Policies - API constraints.
//
// API: https://apidocs.pingidentity.com/pingone/platform/v1/api/#device-authentication-policies
// (documented under the MFA service; same api.pingone.<region>/v1 host and
// /environments/{id}/... base path as the rest of this app). Field names
// verified against patrickcping/pingone-go-sdk-v2's `mfa` package, generated
// from Ping's own OpenAPI spec.
//
// This models the SMS / Voice / Email / TOTP / Mobile / FIDO2 channels - the
// most commonly configured authenticators. Deliberately NOT modeled here
// (PingOne applies its own defaults when the key is omitted):
//   - rememberMe, whatsApp, desktop, yubikey, oathToken, notificationsPolicy
//   - mobile's full schema (push / applications array / pairing keys) - only
//     enabled/disabled is exposed
//   - FIDO2 Policy CRUD itself (a separate PingOne resource) - fido2PolicyId
//     is a free-text reference to an existing policy
// =============================================================================

export const NEW_DEVICE_NOTIFICATIONS = ['NONE', 'EMAIL_THEN_SMS', 'SMS_THEN_EMAIL'] as const
export const DEVICE_SELECTIONS = ['DEFAULT_TO_FIRST', 'PROMPT_TO_SELECT', 'ALWAYS_DISPLAY_DEVICES'] as const

export const MAX_POLICY_NAME_LENGTH = 256
export const MIN_OTP_FAILURE_COUNT = 1
export const MAX_OTP_FAILURE_COUNT = 7
export const MIN_OTP_LENGTH = 6
export const MAX_OTP_LENGTH = 10
export const MIN_PASSCODE_GRACE_PERIOD = 1
export const MAX_PASSCODE_GRACE_PERIOD = 10

export interface MfaDevicePolicySpec {
  sectionName: string
  name: string
  default: boolean
  newDeviceNotification: string
  deviceSelection: string
  ignoreUserLock: boolean

  smsEnabled: boolean
  smsOtpLifetimeSeconds: number
  smsOtpFailureCount: number
  smsOtpCoolDownMinutes: number
  smsOtpLength: number

  voiceEnabled: boolean
  voiceOtpLifetimeSeconds: number
  voiceOtpFailureCount: number
  voiceOtpCoolDownMinutes: number
  voiceOtpLength: number

  emailEnabled: boolean
  emailOtpLifetimeSeconds: number
  emailOtpFailureCount: number
  emailOtpCoolDownMinutes: number
  emailOtpLength: number

  totpEnabled: boolean
  totpFailureCount: number
  totpCoolDownMinutes: number
  totpPasscodeGracePeriod: number

  mobileEnabled: boolean
  fido2Enabled: boolean
  /** Free-text reference to an existing FIDO2 policy; undefined = environment default. */
  fido2PolicyId?: string
}

/**
 * Shape of a policy returned by GET /deviceAuthenticationPolicies. Carries an
 * index signature so the channel sub-objects (sms, voice, ...) stay readable
 * and a live policy can be handed to helpers typed as `Record<string, unknown>`.
 */
export interface LiveMfaDevicePolicy {
  id?: string
  environment?: unknown
  name?: string
  default?: boolean
  newDeviceNotification?: string
  authentication?: { deviceSelection?: string }
  ignoreUserLock?: boolean
  sms?: Record<string, unknown>
  voice?: Record<string, unknown>
  email?: Record<string, unknown>
  totp?: Record<string, unknown>
  mobile?: Record<string, unknown>
  fido2?: Record<string, unknown>
  updatedAt?: string
  forSignOnPolicy?: unknown
  _links?: unknown
  [key: string]: unknown
}

// --- Field coercion helpers ----------------------------------------------------

function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function toTrimmedString(value: unknown, fallback = ''): string {
  const s = typeof value === 'string' ? value.trim() : ''
  return s || fallback
}

function toOptionalString(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim() : ''
  return s || undefined
}

/**
 * Parse a canvas numeric field. Undefined when blank/absent (extraction falls
 * back to the field's canvas default), NaN when present but not a finite
 * number (so validate can reject it), else the number.
 */
function toOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : NaN
  }
  return NaN
}

function resolveNumber(value: unknown, fallback: number): number {
  const parsed = toOptionalNumber(value)
  return parsed === undefined ? fallback : parsed
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

/** Each canvas item describes one PingOne MFA device authentication policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): MfaDevicePolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    return {
      sectionName: section.name,
      name: toTrimmedString(fields.name),
      default: toBool(fields.default, false),
      newDeviceNotification: toTrimmedString(fields.newDeviceNotification, 'NONE').toUpperCase(),
      deviceSelection: toTrimmedString(fields.deviceSelection, 'DEFAULT_TO_FIRST').toUpperCase(),
      ignoreUserLock: toBool(fields.ignoreUserLock, false),

      smsEnabled: toBool(fields.smsEnabled, false),
      smsOtpLifetimeSeconds: resolveNumber(fields.smsOtpLifetimeSeconds, 180),
      smsOtpFailureCount: resolveNumber(fields.smsOtpFailureCount, 3),
      smsOtpCoolDownMinutes: resolveNumber(fields.smsOtpCoolDownMinutes, 30),
      smsOtpLength: resolveNumber(fields.smsOtpLength, 6),

      voiceEnabled: toBool(fields.voiceEnabled, false),
      voiceOtpLifetimeSeconds: resolveNumber(fields.voiceOtpLifetimeSeconds, 180),
      voiceOtpFailureCount: resolveNumber(fields.voiceOtpFailureCount, 3),
      voiceOtpCoolDownMinutes: resolveNumber(fields.voiceOtpCoolDownMinutes, 30),
      voiceOtpLength: resolveNumber(fields.voiceOtpLength, 6),

      emailEnabled: toBool(fields.emailEnabled, false),
      emailOtpLifetimeSeconds: resolveNumber(fields.emailOtpLifetimeSeconds, 1800),
      emailOtpFailureCount: resolveNumber(fields.emailOtpFailureCount, 3),
      emailOtpCoolDownMinutes: resolveNumber(fields.emailOtpCoolDownMinutes, 30),
      emailOtpLength: resolveNumber(fields.emailOtpLength, 6),

      totpEnabled: toBool(fields.totpEnabled, false),
      totpFailureCount: resolveNumber(fields.totpFailureCount, 3),
      totpCoolDownMinutes: resolveNumber(fields.totpCoolDownMinutes, 30),
      totpPasscodeGracePeriod: resolveNumber(fields.totpPasscodeGracePeriod, 5),

      mobileEnabled: toBool(fields.mobileEnabled, false),
      fido2Enabled: toBool(fields.fido2Enabled, false),
      fido2PolicyId: toOptionalString(fields.fido2PolicyId),
    }
  })
}

// --- Per-channel validation helpers --------------------------------------------

function checkFailureCount(
  errors: ValidationResult['errors'],
  field: string,
  label: string,
  value: number,
): void {
  if (!Number.isInteger(value) || value < MIN_OTP_FAILURE_COUNT || value > MAX_OTP_FAILURE_COUNT) {
    errors.push({
      field,
      message: `${label} failure count must be an integer between ${MIN_OTP_FAILURE_COUNT} and ${MAX_OTP_FAILURE_COUNT}`,
      code: 'invalid_failure_count',
    })
  }
}

function checkOtpLength(errors: ValidationResult['errors'], field: string, label: string, value: number): void {
  if (!Number.isInteger(value) || value < MIN_OTP_LENGTH || value > MAX_OTP_LENGTH) {
    errors.push({
      field,
      message: `${label} OTP length must be an integer between ${MIN_OTP_LENGTH} and ${MAX_OTP_LENGTH}`,
      code: 'invalid_otp_length',
    })
  }
}

function checkNonNegativeDuration(
  errors: ValidationResult['errors'],
  field: string,
  label: string,
  value: number,
): void {
  if (!Number.isInteger(value) || value < 0) {
    errors.push({ field, message: `${label} must be a non-negative integer`, code: 'invalid_duration' })
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate MFA device authentication policy configurations against the
 * PingOne API. Static only - it never contacts PingOne:
 *   - name is required, <= 256 chars, and unique within the canvas
 *   - newDeviceNotification is one of NONE | EMAIL_THEN_SMS | SMS_THEN_EMAIL
 *   - deviceSelection is one of DEFAULT_TO_FIRST | PROMPT_TO_SELECT | ALWAYS_DISPLAY_DEVICES
 *   - every *FailureCount (sms/voice/email/totp) is an integer between 1 and 7
 *   - sms/voice/email *OtpLength is an integer between 6 and 10
 *   - totpPasscodeGracePeriod is an integer between 1 and 10
 *   - every OTP lifetime/cool-down duration is a non-negative integer
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name - required, <= 256 chars, unique
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_POLICY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Policy name must be ${MAX_POLICY_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" - each policy may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // newDeviceNotification - must be a supported enum value
    if (!(NEW_DEVICE_NOTIFICATIONS as readonly string[]).includes(spec.newDeviceNotification)) {
      errors.push({
        field: `${prefix}.newDeviceNotification`,
        message: `New device notification must be one of: ${NEW_DEVICE_NOTIFICATIONS.join(', ')}`,
        code: 'invalid_new_device_notification',
      })
    }

    // deviceSelection - must be a supported enum value
    if (!(DEVICE_SELECTIONS as readonly string[]).includes(spec.deviceSelection)) {
      errors.push({
        field: `${prefix}.deviceSelection`,
        message: `Device selection must be one of: ${DEVICE_SELECTIONS.join(', ')}`,
        code: 'invalid_device_selection',
      })
    }

    // SMS
    checkFailureCount(errors, `${prefix}.smsOtpFailureCount`, 'SMS', spec.smsOtpFailureCount)
    checkOtpLength(errors, `${prefix}.smsOtpLength`, 'SMS', spec.smsOtpLength)
    checkNonNegativeDuration(errors, `${prefix}.smsOtpLifetimeSeconds`, 'SMS OTP lifetime (seconds)', spec.smsOtpLifetimeSeconds)
    checkNonNegativeDuration(errors, `${prefix}.smsOtpCoolDownMinutes`, 'SMS OTP cool-down (minutes)', spec.smsOtpCoolDownMinutes)

    // Voice
    checkFailureCount(errors, `${prefix}.voiceOtpFailureCount`, 'Voice', spec.voiceOtpFailureCount)
    checkOtpLength(errors, `${prefix}.voiceOtpLength`, 'Voice', spec.voiceOtpLength)
    checkNonNegativeDuration(errors, `${prefix}.voiceOtpLifetimeSeconds`, 'Voice OTP lifetime (seconds)', spec.voiceOtpLifetimeSeconds)
    checkNonNegativeDuration(errors, `${prefix}.voiceOtpCoolDownMinutes`, 'Voice OTP cool-down (minutes)', spec.voiceOtpCoolDownMinutes)

    // Email
    checkFailureCount(errors, `${prefix}.emailOtpFailureCount`, 'Email', spec.emailOtpFailureCount)
    checkOtpLength(errors, `${prefix}.emailOtpLength`, 'Email', spec.emailOtpLength)
    checkNonNegativeDuration(errors, `${prefix}.emailOtpLifetimeSeconds`, 'Email OTP lifetime (seconds)', spec.emailOtpLifetimeSeconds)
    checkNonNegativeDuration(errors, `${prefix}.emailOtpCoolDownMinutes`, 'Email OTP cool-down (minutes)', spec.emailOtpCoolDownMinutes)

    // TOTP - no lifeTime (passcodes are time-based, not server-issued)
    checkFailureCount(errors, `${prefix}.totpFailureCount`, 'Authenticator app (TOTP)', spec.totpFailureCount)
    checkNonNegativeDuration(
      errors,
      `${prefix}.totpCoolDownMinutes`,
      'Authenticator app (TOTP) cool-down (minutes)',
      spec.totpCoolDownMinutes,
    )
    if (
      !Number.isInteger(spec.totpPasscodeGracePeriod) ||
      spec.totpPasscodeGracePeriod < MIN_PASSCODE_GRACE_PERIOD ||
      spec.totpPasscodeGracePeriod > MAX_PASSCODE_GRACE_PERIOD
    ) {
      errors.push({
        field: `${prefix}.totpPasscodeGracePeriod`,
        message: `Passcode grace period must be an integer between ${MIN_PASSCODE_GRACE_PERIOD} and ${MAX_PASSCODE_GRACE_PERIOD}`,
        code: 'invalid_grace_period',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
