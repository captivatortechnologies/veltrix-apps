import validate, { extractMfaMethodSpecs, optionalNumber } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'mfa-methods',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'mfa-methods',
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
    toolType: 'hashicorp-vault',
    entityType: 'mfa-methods',
    items: sections,
    sections,
    snapshot: {},
  }
}

const VALID_TOTP = { methodName: 'Corp TOTP', type: 'totp', issuer: 'Veltrix' }
const VALID_DUO = {
  methodName: 'Corp Duo',
  type: 'duo',
  apiHostname: 'api-abc123.duosecurity.com',
  integrationKey: 'DIXXXXXXXXXXXXXXXXXX',
  secretKey: 'sk-super-secret-value',
}
const VALID_OKTA = { methodName: 'Corp Okta', type: 'okta', orgName: 'acme', apiToken: 'okta-tok-123' }
const VALID_PINGID = { methodName: 'Corp PingID', type: 'pingid', settingsFileBase64: 'c2V0dGluZ3M=' }

describe('Vault Login MFA Methods Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid totp method', async () => {
    const result = await validate(makeCtx([{ name: 'M1', fields: VALID_TOTP }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid duo method with secrets', async () => {
    const result = await validate(makeCtx([{ name: 'M1', fields: VALID_DUO }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid okta method', async () => {
    const result = await validate(makeCtx([{ name: 'M1', fields: VALID_OKTA }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid pingid method', async () => {
    const result = await validate(makeCtx([{ name: 'M1', fields: VALID_PINGID }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing method name', async () => {
    const result = await validate(makeCtx([{ name: 'M1', fields: { type: 'totp', issuer: 'Veltrix' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('methodName'))).toBe(true)
  })

  it('rejects a method name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'M1', fields: { methodName: 'x'.repeat(256), type: 'totp', issuer: 'Veltrix' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing or unknown type', async () => {
    const missing = await validate(makeCtx([{ name: 'M1', fields: { methodName: 'X' } }]))
    expect(missing.valid).toBe(false)
    expect(missing.errors.some((e) => e.code === 'invalid_type')).toBe(true)

    const unknown = await validate(makeCtx([{ name: 'M1', fields: { methodName: 'X', type: 'yubikey' } }]))
    expect(unknown.valid).toBe(false)
    expect(unknown.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects a totp method with no issuer', async () => {
    const result = await validate(makeCtx([{ name: 'M1', fields: { methodName: 'X', type: 'totp' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('issuer'))).toBe(true)
  })

  it('rejects a duo method missing its write-only secrets', async () => {
    const result = await validate(
      makeCtx([{ name: 'M1', fields: { methodName: 'X', type: 'duo', apiHostname: 'api-a.duosecurity.com' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('integrationKey'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('secretKey'))).toBe(true)
  })

  it('rejects a duo method missing its api hostname', async () => {
    const result = await validate(
      makeCtx([{ name: 'M1', fields: { methodName: 'X', type: 'duo', integrationKey: 'ik', secretKey: 'sk' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('apiHostname'))).toBe(true)
  })

  it('rejects an okta method missing its api token', async () => {
    const result = await validate(makeCtx([{ name: 'M1', fields: { methodName: 'X', type: 'okta', orgName: 'acme' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('apiToken'))).toBe(true)
  })

  it('rejects a pingid method missing its settings file', async () => {
    const result = await validate(makeCtx([{ name: 'M1', fields: { methodName: 'X', type: 'pingid' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('settingsFileBase64'))).toBe(true)
  })

  it('rejects an invalid totp algorithm', async () => {
    const result = await validate(
      makeCtx([{ name: 'M1', fields: { ...VALID_TOTP, algorithm: 'MD5' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_algorithm')).toBe(true)
  })

  it('rejects invalid totp digits', async () => {
    const result = await validate(makeCtx([{ name: 'M1', fields: { ...VALID_TOTP, digits: '7' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_digits')).toBe(true)
  })

  it('rejects an invalid totp skew', async () => {
    const result = await validate(makeCtx([{ name: 'M1', fields: { ...VALID_TOTP, skew: '5' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_skew')).toBe(true)
  })

  it('rejects a non-positive or non-numeric totp period', async () => {
    const negative = await validate(makeCtx([{ name: 'M1', fields: { ...VALID_TOTP, period: '0' } }]))
    expect(negative.valid).toBe(false)
    expect(negative.errors.some((e) => e.code === 'invalid_number' && e.field.includes('period'))).toBe(true)

    const nan = await validate(makeCtx([{ name: 'M1', fields: { ...VALID_TOTP, keySize: 'abc' } }]))
    expect(nan.valid).toBe(false)
    expect(nan.errors.some((e) => e.code === 'invalid_number' && e.field.includes('keySize'))).toBe(true)
  })

  it('accepts valid totp numeric params', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'M1',
          fields: { ...VALID_TOTP, period: '30', keySize: '20', digits: '8', skew: '1', maxValidationAttempts: '5', algorithm: 'SHA256' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a duplicate method name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'M1', fields: VALID_TOTP },
        { name: 'M2', fields: { ...VALID_DUO, methodName: 'Corp TOTP' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_method')).toBe(true)
  })

  it('allows distinct method names across types', async () => {
    const result = await validate(
      makeCtx([
        { name: 'M1', fields: VALID_TOTP },
        { name: 'M2', fields: VALID_DUO },
        { name: 'M3', fields: VALID_OKTA },
        { name: 'M4', fields: VALID_PINGID },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractMfaMethodSpecs', () => {
  it('trims the name, lower-cases the type, coerces numbers and drops empty optionals', () => {
    const specs = extractMfaMethodSpecs(
      makeCanvas([
        {
          name: 'M1',
          fields: {
            methodName: '  Corp TOTP  ',
            type: '  TOTP  ',
            issuer: 'Veltrix',
            period: '30',
            digits: '6',
            algorithm: '  ',
          },
        },
      ]),
    )
    expect(specs[0].methodName).toBe('Corp TOTP')
    expect(specs[0].type).toBe('totp')
    expect(specs[0].period).toBe(30)
    expect(specs[0].digits).toBe(6)
    expect(specs[0].algorithm).toBeUndefined()
  })

  it('preserves the exact secret characters but treats whitespace as blank', () => {
    const specs = extractMfaMethodSpecs(
      makeCanvas([
        {
          name: 'M1',
          fields: { methodName: 'Corp Duo', type: 'duo', integrationKey: '  ik with spaces  ', secretKey: '   ' },
        },
      ]),
    )
    // A real secret keeps its inner spaces (not trimmed).
    expect(specs[0].integrationKey).toBe('  ik with spaces  ')
    // A whitespace-only secret is treated as blank (undefined) so validate rejects it.
    expect(specs[0].secretKey).toBeUndefined()
  })

  it('normalizes an unknown type to empty string', () => {
    const specs = extractMfaMethodSpecs(makeCanvas([{ name: 'M1', fields: { methodName: 'X', type: 'sms' } }]))
    expect(specs[0].type).toBe('')
  })
})

describe('optionalNumber', () => {
  it('coerces numbers and numeric strings', () => {
    expect(optionalNumber('30')).toBe(30)
    expect(optionalNumber(8)).toBe(8)
  })
  it('returns undefined for blank input', () => {
    expect(optionalNumber('')).toBeUndefined()
    expect(optionalNumber('   ')).toBeUndefined()
    expect(optionalNumber(undefined)).toBeUndefined()
    expect(optionalNumber(null)).toBeUndefined()
  })
  it('returns NaN for a non-numeric value', () => {
    expect(Number.isNaN(optionalNumber('abc') as number)).toBe(true)
  })
})
