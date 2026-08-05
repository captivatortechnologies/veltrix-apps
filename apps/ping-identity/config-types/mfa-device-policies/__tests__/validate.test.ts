import validate, {
  DEVICE_SELECTIONS,
  NEW_DEVICE_NOTIFICATIONS,
  extractPolicySpecs,
} from '../validate'
import { buildFido2Channel, buildPolicyBody, stripReadOnlyPolicyFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'ping-identity',
    customerId: 'cust-1',
    configTypeId: 'mfa-device-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'ping-identity',
      entityType: 'mfa-device-policies',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'ping-identity',
    entityType: 'mfa-device-policies',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('PingOne MFA Device Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a policy authored with only a name (canvas defaults fill the rest)', async () => {
    const result = await validate(makeCtx([{ name: 'Policy', fields: { name: 'Standard MFA Policy' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a fully-specified policy across every channel', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Policy',
          fields: {
            name: 'Full MFA Policy',
            default: true,
            newDeviceNotification: 'EMAIL_THEN_SMS',
            deviceSelection: 'PROMPT_TO_SELECT',
            ignoreUserLock: true,
            smsEnabled: true,
            smsOtpLifetimeSeconds: 300,
            smsOtpFailureCount: 5,
            smsOtpCoolDownMinutes: 15,
            smsOtpLength: 8,
            voiceEnabled: true,
            emailEnabled: true,
            totpEnabled: true,
            totpFailureCount: 7,
            totpPasscodeGracePeriod: 10,
            mobileEnabled: true,
            fido2Enabled: true,
            fido2PolicyId: 'fido2pol123',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 256 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(257) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a duplicate policy name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Default Policy' } },
        { name: 'sec2', fields: { name: 'default policy' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects an invalid newDeviceNotification', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Policy', newDeviceNotification: 'CARRIER_PIGEON' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_new_device_notification')).toBe(true)
  })

  it('rejects an invalid deviceSelection', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Policy', deviceSelection: 'RANDOM' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_device_selection')).toBe(true)
  })

  it.each([
    ['smsOtpFailureCount', 0],
    ['smsOtpFailureCount', 8],
    ['voiceOtpFailureCount', 0],
    ['emailOtpFailureCount', 8],
    ['totpFailureCount', 0],
    ['totpFailureCount', 8],
  ])('rejects an out-of-range %s of %d', async (field, value) => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Policy', [field]: value } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_failure_count' && e.field.endsWith(field))).toBe(true)
  })

  it('rejects a non-integer failure count', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Policy', smsOtpFailureCount: 3.5 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_failure_count')).toBe(true)
  })

  it.each([
    ['smsOtpLength', 5],
    ['smsOtpLength', 11],
    ['voiceOtpLength', 5],
    ['emailOtpLength', 11],
  ])('rejects an out-of-range %s of %d', async (field, value) => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Policy', [field]: value } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_otp_length' && e.field.endsWith(field))).toBe(true)
  })

  it.each([0, 11])('rejects an out-of-range totpPasscodeGracePeriod of %d', async (value) => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Policy', totpPasscodeGracePeriod: value } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_grace_period')).toBe(true)
  })

  it('rejects a negative OTP lifetime/cool-down duration', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Policy', smsOtpLifetimeSeconds: -1, voiceOtpCoolDownMinutes: -5 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'invalid_duration')).toHaveLength(2)
  })
})

describe('extractPolicySpecs', () => {
  it('trims the name and applies canvas defaults when fields are blank', () => {
    const specs = extractPolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: '  Office MFA  ' } }]))
    expect(specs[0].name).toBe('Office MFA')
    expect(specs[0].default).toBe(false)
    expect(specs[0].newDeviceNotification).toBe('NONE')
    expect(specs[0].deviceSelection).toBe('DEFAULT_TO_FIRST')
    expect(specs[0].smsOtpLifetimeSeconds).toBe(180)
    expect(specs[0].smsOtpFailureCount).toBe(3)
    expect(specs[0].smsOtpCoolDownMinutes).toBe(30)
    expect(specs[0].smsOtpLength).toBe(6)
    expect(specs[0].emailOtpLifetimeSeconds).toBe(1800)
    expect(specs[0].totpPasscodeGracePeriod).toBe(5)
    expect(specs[0].fido2PolicyId).toBeUndefined()
  })

  it('upper-cases enum-like select fields regardless of input case', () => {
    const specs = extractPolicySpecs(
      makeCanvas([
        { name: 'sec1', fields: { name: 'P', newDeviceNotification: '  email_then_sms  ', deviceSelection: 'prompt_to_select' } },
      ]),
    )
    expect(specs[0].newDeviceNotification).toBe('EMAIL_THEN_SMS')
    expect(specs[0].deviceSelection).toBe('PROMPT_TO_SELECT')
  })

  it('preserves an explicitly invalid (non-numeric) field as NaN instead of silently defaulting it', () => {
    const specs = extractPolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'P', smsOtpFailureCount: 'nope' } }]))
    expect(Number.isNaN(specs[0].smsOtpFailureCount)).toBe(true)
  })
})

describe('NEW_DEVICE_NOTIFICATIONS / DEVICE_SELECTIONS', () => {
  it('exposes the three supported notification modes and device-selection strategies', () => {
    expect(NEW_DEVICE_NOTIFICATIONS).toEqual(['NONE', 'EMAIL_THEN_SMS', 'SMS_THEN_EMAIL'])
    expect(DEVICE_SELECTIONS).toEqual(['DEFAULT_TO_FIRST', 'PROMPT_TO_SELECT', 'ALWAYS_DISPLAY_DEVICES'])
  })
})

describe('buildPolicyBody', () => {
  const baseSpec = extractPolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'Base Policy' } }]))[0]

  it('always sends sms/voice/email/totp/mobile even when every channel is disabled', () => {
    const body = buildPolicyBody(baseSpec)
    expect(body.sms).toEqual({
      enabled: false,
      otp: {
        lifeTime: { duration: 180, timeUnit: 'SECONDS' },
        failure: { count: 3, coolDown: { duration: 30, timeUnit: 'MINUTES' } },
        otpLength: 6,
      },
    })
    expect(body.mobile).toEqual({ enabled: false })
    expect(body.totp).toEqual({
      enabled: false,
      otp: { failure: { count: 3, coolDown: { duration: 30, timeUnit: 'MINUTES' } } },
      passcodeGracePeriod: 5,
    })
    // TOTP never carries lifeTime - passcodes are time-based, not server-issued.
    expect((body.totp as { otp: Record<string, unknown> }).otp.lifeTime).toBeUndefined()
  })

  it('omits fido2 entirely when neither enabled nor a policy id is set', () => {
    const body = buildPolicyBody(baseSpec)
    expect(body.fido2).toBeUndefined()
    expect('fido2' in body).toBe(false)
  })

  it('includes fido2 when enabled, with the policy id when set', () => {
    const spec = {
      ...baseSpec,
      fido2Enabled: true,
      fido2PolicyId: 'fido2pol123',
    }
    const body = buildPolicyBody(spec)
    expect(body.fido2).toEqual({ enabled: true, fido2PolicyId: 'fido2pol123' })
  })

  it('lets the modeled name/default/authentication fields reflect the spec', () => {
    const spec = { ...baseSpec, name: 'My Policy', default: true, deviceSelection: 'PROMPT_TO_SELECT' }
    const body = buildPolicyBody(spec)
    expect(body.name).toBe('My Policy')
    expect(body.default).toBe(true)
    expect(body.authentication).toEqual({ deviceSelection: 'PROMPT_TO_SELECT' })
  })
})

describe('buildFido2Channel', () => {
  const baseSpec = extractPolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'Base Policy' } }]))[0]

  it('returns undefined when disabled and no policy id is set', () => {
    expect(buildFido2Channel(baseSpec)).toBeUndefined()
  })

  it('returns a channel with the policy id omitted when blank', () => {
    expect(buildFido2Channel({ ...baseSpec, fido2Enabled: true })).toEqual({ enabled: true })
  })

  it('includes fido2PolicyId even if fido2 itself is not enabled (explicit reference wins)', () => {
    expect(buildFido2Channel({ ...baseSpec, fido2PolicyId: 'abc' })).toEqual({ enabled: false, fido2PolicyId: 'abc' })
  })
})

describe('stripReadOnlyPolicyFields', () => {
  it('removes id/environment/updatedAt/_links/forSignOnPolicy but keeps the rest', () => {
    const stripped = stripReadOnlyPolicyFields({
      id: 'devauthpol123',
      environment: { id: 'env1' },
      name: 'Policy',
      default: true,
      updatedAt: '2020-01-01T00:00:00Z',
      forSignOnPolicy: false,
      _links: { self: {} },
      sms: { enabled: true },
    })
    expect(stripped).toEqual({
      name: 'Policy',
      default: true,
      sms: { enabled: true },
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.environment).toBeUndefined()
    expect(stripped.updatedAt).toBeUndefined()
    expect(stripped.forSignOnPolicy).toBeUndefined()
    expect(stripped._links).toBeUndefined()
  })
})
